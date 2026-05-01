import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';

export type ContainerState = 'stopped' | 'starting' | 'running' | 'restarting';

interface ContainerRecord {
  projectRoot: string;
  state: ContainerState;
  containerId: string | null;
  remoteWorkspaceFolder: string | null;
  startPromise: Promise<void> | null;
  eventWatcher: ChildProcess | null;
}

export interface ContainerInfo {
  containerId: string;
  remoteWorkspaceFolder: string;
}

function devcontainerBin(): string {
  const ext = process.platform === 'win32' ? '.cmd' : '';
  const local = path.join(process.cwd(), 'node_modules', '.bin', `devcontainer${ext}`);
  return existsSync(local) ? local : `devcontainer${ext}`;
}

export function readContainerConfig(projectRoot: string): { enabled: boolean } {
  const cfgPath = path.join(projectRoot, '.teamai', 'container.json');
  if (!existsSync(cfgPath)) return { enabled: false };
  try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { return { enabled: false }; }
}

// Translate a host absolute path into the equivalent path inside the container.
// hostProjectRoot (host) maps to containerWorkspace (container).
export function hostToContainerPath(
  hostPath: string,
  hostProjectRoot: string,
  containerWorkspace: string,
): string {
  const rel = path.relative(hostProjectRoot, hostPath).replace(/\\/g, '/');
  return `${containerWorkspace}/${rel}`;
}

export class ContainerManager extends EventEmitter {
  private records = new Map<string, ContainerRecord>();

  async ensureContainer(projectRoot: string): Promise<ContainerInfo> {
    let record = this.records.get(projectRoot);

    if (!record || record.state === 'stopped') {
      record = {
        projectRoot,
        state: 'starting',
        containerId: null,
        remoteWorkspaceFolder: null,
        startPromise: null,
        eventWatcher: null,
      };
      this.records.set(projectRoot, record);
      this._emit(record, 'starting');
      record.startPromise = this._doStart(record);
    }

    if (record.state === 'starting' || record.state === 'restarting') {
      await record.startPromise;
    }

    if (record.state !== 'running' || !record.containerId || !record.remoteWorkspaceFolder) {
      throw new Error(`Container for ${projectRoot} is not available (state: ${record.state})`);
    }

    return { containerId: record.containerId, remoteWorkspaceFolder: record.remoteWorkspaceFolder };
  }

  getState(projectRoot: string): ContainerState {
    return this.records.get(projectRoot)?.state ?? 'stopped';
  }

  // Returns the running container info synchronously — for use in orchestrator git commands.
  // Returns null if the container is not currently running.
  getRunningContainer(projectRoot: string): ContainerInfo | null {
    const r = this.records.get(projectRoot);
    if (r?.state === 'running' && r.containerId && r.remoteWorkspaceFolder) {
      return { containerId: r.containerId, remoteWorkspaceFolder: r.remoteWorkspaceFolder };
    }
    return null;
  }

  private async _doStart(record: ContainerRecord): Promise<void> {
    // Credential mounts (claude, gitconfig, ssh) are declared in devcontainer.json.
    // postCreateCommand installs claude, playwright-mcp, and gh CLI.
    const args = [
      'up',
      '--workspace-folder', record.projectRoot,
      '--log-format', 'json',
    ];

    try {
      const { containerId, remoteWorkspaceFolder } = await this._spawnDevcontainerUp(args);
      record.containerId = containerId;
      record.remoteWorkspaceFolder = remoteWorkspaceFolder;
      record.state = 'running';
      record.startPromise = null;
      console.log(`[container] Started — id=${containerId} workspace=${remoteWorkspaceFolder}`);
      this._emit(record, 'running');
      this._watchEvents(record);
    } catch (err) {
      record.state = 'stopped';
      record.containerId = null;
      record.remoteWorkspaceFolder = null;
      record.startPromise = null;
      this._emit(record, 'stopped');
      throw err;
    }
  }

  private _spawnDevcontainerUp(args: string[]): Promise<ContainerInfo> {
    return new Promise((resolve, reject) => {
      const proc = spawn(devcontainerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', err => reject(new Error(`devcontainer not found: ${err.message}`)));
      proc.on('exit', code => {
        // With --log-format json each line is a JSON object; find the result line (has "outcome")
        const resultLine = stdout.trim().split('\n')
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .find(o => o && 'outcome' in o);

        // Accept the container even on non-zero exit if we have a containerId —
        // postCreateCommand failures (e.g. from bind-mounted files) leave a working container.
        if (resultLine?.containerId && resultLine?.remoteWorkspaceFolder) {
          if (resultLine.outcome !== 'success') {
            console.warn(`[container] devcontainer up exited with outcome "${resultLine.outcome}" — continuing anyway (postCreateCommand likely partial)`);
          }
          return resolve({ containerId: resultLine.containerId, remoteWorkspaceFolder: resultLine.remoteWorkspaceFolder });
        }

        if (code !== 0) return reject(new Error(`devcontainer up failed (exit ${code}):\n${stderr}`));
        if (!resultLine) return reject(new Error(`No result JSON in devcontainer output:\n${stdout}`));
        return reject(new Error(`devcontainer up outcome: ${resultLine.outcome}\n${stderr}`));
      });
    });
  }

  private _watchEvents(record: ContainerRecord): void {
    const watcher = spawn('docker', [
      'events',
      '--filter', `container=${record.containerId}`,
      '--filter', 'event=die',
      '--format', '{{.Action}}',
    ]);
    record.eventWatcher = watcher;
    watcher.stdout?.on('data', () => this._onContainerDied(record));
    watcher.on('exit', () => {
      if (record.state === 'running') this._onContainerDied(record);
    });
    watcher.on('error', () => {
      if (record.state === 'running') this._onContainerDied(record);
    });
  }

  private _onContainerDied(record: ContainerRecord): void {
    if (record.state !== 'running') return; // single-restart guard

    console.log(`[container] Container for ${record.projectRoot} died — attempting one restart`);
    record.state = 'restarting';
    record.containerId = null;
    record.remoteWorkspaceFolder = null;
    record.eventWatcher?.kill();
    record.eventWatcher = null;
    this._emit(record, 'restarting');

    record.startPromise = this._doStart(record).catch(() => {
      // _doStart sets state = 'stopped' on failure
    });
  }

  private _emit(record: ContainerRecord, state: ContainerState): void {
    this.emit('container-state', { projectRoot: record.projectRoot, state });
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __containerManager: ContainerManager | undefined;
}

export const containerManager: ContainerManager =
  global.__containerManager ?? (global.__containerManager = new ContainerManager());

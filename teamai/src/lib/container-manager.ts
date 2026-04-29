import { spawn, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import os from 'os';

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

// Docker on Windows accepts forward-slash paths
function toDockerPath(p: string): string {
  return process.platform === 'win32' ? p.replace(/\\/g, '/') : p;
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

  private async _doStart(record: ContainerRecord): Promise<void> {
    const home = os.homedir();
    const mounts: string[] = [];

    for (const [src, dst, extra] of [
      [path.join(home, '.claude'),    '/root/.claude',    ''],
      [path.join(home, '.gitconfig'), '/root/.gitconfig', ''],
      [path.join(home, '.ssh'),       '/root/.ssh',       ',readonly'],
    ] as [string, string, string][]) {
      if (existsSync(src)) {
        mounts.push(`type=bind,source=${toDockerPath(src)},target=${dst}${extra}`);
      }
    }

    const args = [
      'up',
      '--workspace-folder', record.projectRoot,
      '--output-format', 'json',
      ...mounts.flatMap(m => ['--mount', m]),
    ];

    try {
      const { containerId, remoteWorkspaceFolder } = await this._spawnDevcontainerUp(args);
      record.containerId = containerId;
      record.remoteWorkspaceFolder = remoteWorkspaceFolder;
      record.state = 'running';
      record.startPromise = null;
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

  private _spawnDevcontainerUp(args: string[]): Promise<{ containerId: string; remoteWorkspaceFolder: string }> {
    return new Promise((resolve, reject) => {
      const proc = spawn(devcontainerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      proc.on('error', err => reject(new Error(`devcontainer not found: ${err.message}`)));
      proc.on('exit', code => {
        if (code !== 0) return reject(new Error(`devcontainer up failed (exit ${code}):\n${stderr}`));
        const jsonLine = stdout.trim().split('\n').filter(l => l.trimStart().startsWith('{')).pop();
        if (!jsonLine) return reject(new Error(`No JSON in devcontainer output:\n${stdout}`));
        try {
          const result = JSON.parse(jsonLine);
          if (result.outcome !== 'success') {
            return reject(new Error(`devcontainer up outcome: ${result.outcome}\n${stderr}`));
          }
          resolve({ containerId: result.containerId, remoteWorkspaceFolder: result.remoteWorkspaceFolder });
        } catch {
          reject(new Error(`Failed to parse devcontainer output:\n${stdout}`));
        }
      });
    });
  }

  private _watchEvents(record: ContainerRecord): void {
    const watcher = spawn('docker', [
      'events',
      '--filter', `container=${record.containerId}`,
      '--filter', 'event=die',
      '--format', '{{.Status}}',
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
      // _doStart sets state = 'stopped' on failure; nothing extra needed
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

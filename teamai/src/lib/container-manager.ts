import { spawn, execFileSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync, appendFileSync } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import { warn as logWarn } from './logger';

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

// Check if Docker is available and running (cached per process lifetime)
let _dockerAvailable: boolean | null = null;

/** @internal Reset the docker-available cache (used in tests) */
export function _resetDockerAvailableCache(): void {
  _dockerAvailable = null;
}

export function dockerAvailable(): boolean {
  if (_dockerAvailable !== null) return _dockerAvailable;
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore', timeout: 2000 });
    _dockerAvailable = true;
  } catch (err) {
    _dockerAvailable = false;
    logWarn('container', 'docker info check failed', err);
  }
  return _dockerAvailable;
}

export function readContainerConfig(projectRoot: string): { enabled: boolean; explicit: boolean } {
  const cfgPath = path.join(projectRoot, '.teamai', 'container.json');
  if (existsSync(cfgPath)) {
    try { return { ...JSON.parse(readFileSync(cfgPath, 'utf-8')), explicit: true }; } catch (err) { logWarn('container', 'Failed to parse container config, using defaults', err); }
  }
  // Default: auto-enable when Docker is available, opt-out otherwise
  return { enabled: dockerAvailable(), explicit: false };
}

/**
 * Read the remoteUser from a project's .devcontainer/devcontainer.json.
 * Falls back to 'node' if the file doesn't exist or parsing fails.
 */
export function readContainerRemoteUser(projectRoot: string): string {
  const devCfgPath = path.join(projectRoot, '.devcontainer', 'devcontainer.json');
  if (existsSync(devCfgPath)) {
    try {
      const cfg = JSON.parse(readFileSync(devCfgPath, 'utf-8'));
      if (cfg.remoteUser) return cfg.remoteUser;
    } catch (err) { logWarn('container', 'Failed to parse devcontainer.json', err); }
  }
  return 'node';
}

// Translate a host absolute path into the equivalent path inside the container.
// hostProjectRoot (host) maps to containerWorkspace (container).
export function hostToContainerPath(
  hostPath: string,
  hostProjectRoot: string,
  containerWorkspace: string,
): string {
  // Normalize Windows paths to POSIX before computing relative path
  const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const rel = path.posix.relative(normalize(hostProjectRoot), normalize(hostPath));
  return `${containerWorkspace}/${rel}`;
}

export class ContainerManager extends EventEmitter {
  private records = new Map<string, ContainerRecord>();

  async ensureContainer(projectRoot: string, logFile?: string): Promise<ContainerInfo> {
    let record = this.records.get(projectRoot);

    if (!record || record.state === 'stopped') {
      // Before running devcontainer up, check if the container is already running
      // (e.g. after a server restart that cleared the in-memory record)
      const existing = this._findRunningContainerSync(projectRoot);
      if (existing) {
        record = {
          projectRoot, state: 'running',
          containerId: existing.containerId,
          remoteWorkspaceFolder: existing.remoteWorkspaceFolder,
          startPromise: null, eventWatcher: null,
        };
        this.records.set(projectRoot, record);
        this._watchEvents(record);
        return existing;
      }

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
      record.startPromise = this._doStart(record, logFile);
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
    const existing = this.records.get(projectRoot);
    if (existing) return existing.state;
    // No in-memory record — check Docker directly for an existing devcontainer
    try {
      // Normalize Windows drive letter to lowercase — Docker stores it lowercase
      // (e.g. cookie has "C:\..." but devcontainer label is "c:\...")
      const normalized = projectRoot.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
      const label = `devcontainer.local_folder=${normalized}`;
      // Use execFileSync to bypass shell quoting (backslashes in Windows paths break execSync's shell)
      const out = execFileSync('docker', [
        'ps', '-a',
        '--filter', `label=${label}`,
        '--format', '{{.Status}}',
      ], { encoding: 'utf-8', timeout: 10000 }).trim();
      if (out.includes('Up')) return 'running';   // container is up
      // Any other output (Exited, Created, etc.) means it's not running — treat as stoppable
      if (out) return 'stopped';
    } catch (err) { logWarn('container', 'Docker status check failed', err); }
    return 'stopped';
  }

  // Synchronously find a running devcontainer via Docker labels — used as fallback
  // when the in-memory record was lost (e.g. after a server restart).
  private _findRunningContainerSync(projectRoot: string): ContainerInfo | null {
    try {
      const normalized = projectRoot.replace(/^([A-Z]):/, (_, d) => `${d.toLowerCase()}:`);
      const label = `devcontainer.local_folder=${normalized}`;
      const containerId = execFileSync('docker', [
        'ps', '--filter', `label=${label}`, '--format', '{{.ID}}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!containerId) return null;

      const mountsJson = execFileSync('docker', [
        'inspect', containerId, '--format', '{{json .Mounts}}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
      const mounts: Array<{ Source: string; Destination: string }> = JSON.parse(mountsJson);

      const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
      const workspaceMount = mounts.find(m =>
        m.Source.replace(/\\/g, '/').toLowerCase() === normalizedRoot
      );
      if (!workspaceMount) return null;

      return { containerId, remoteWorkspaceFolder: workspaceMount.Destination };
    } catch { return null; }
  }

  // Returns the running container info synchronously — for use in orchestrator git commands.
  // Falls back to a Docker label scan when the in-memory record is absent (e.g. server restart).
  getRunningContainer(projectRoot: string): ContainerInfo | null {
    const r = this.records.get(projectRoot);
    if (r?.state === 'running' && r.containerId && r.remoteWorkspaceFolder) {
      return { containerId: r.containerId, remoteWorkspaceFolder: r.remoteWorkspaceFolder };
    }
    const info = this._findRunningContainerSync(projectRoot);
    if (info) {
      // Populate the record so subsequent calls skip the Docker scan
      this.records.set(projectRoot, {
        projectRoot, state: 'running',
        containerId: info.containerId,
        remoteWorkspaceFolder: info.remoteWorkspaceFolder,
        startPromise: null, eventWatcher: null,
      });
    }
    return info;
  }

  private async _doStart(record: ContainerRecord, logFile?: string): Promise<void> {
    // Credential mounts (claude, gitconfig, ssh) are declared in devcontainer.json.
    // postCreateCommand installs claude, playwright-mcp, and gh CLI.
    const args = [
      'up',
      '--workspace-folder', record.projectRoot,
      '--log-format', 'json',
    ];

    try {
      const { containerId, remoteWorkspaceFolder } = await this._spawnDevcontainerUp(args, record.projectRoot, logFile);
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

  private _spawnDevcontainerUp(args: string[], projectRoot: string, logFile?: string): Promise<ContainerInfo> {
    return new Promise((resolve, reject) => {
      const proc = spawn(devcontainerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';

      // Parse devcontainer JSON log lines in real-time to stream progress
      const writeToLog = (msg: string) => {
        if (!logFile) return;
        try { appendFileSync(logFile, msg); } catch { /* best-effort */ }
      };

      proc.stdout?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stdout += chunk;
        // Each line is a JSON log entry — extract meaningful progress
        for (const line of chunk.split('\n').filter(Boolean)) {
          try {
            const entry = JSON.parse(line);
            if (entry.message) {
              const formatted = `◆ ${entry.message}\n`.replace(/\n/g, '\r\n');
              writeToLog(formatted);
              this.emit('container-log', { projectRoot, message: entry.message });
            }
          } catch {
            // Not JSON — skip
          }
        }
      });

      proc.stderr?.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        // Forward docker pull/progress lines to the log and WebSocket in real-time
        for (const line of chunk.split('\n').filter(Boolean)) {
          const message = line.replace(/\r/g, '').trim();
          if (message) {
            const formatted = `  ${message}\n`.replace(/\n/g, '\r\n');
            writeToLog(formatted);
            this.emit('container-log', { projectRoot, message });
          }
        }
      });
      proc.on('error', err => reject(new Error(`devcontainer not found: ${err.message}`)));
      proc.on('exit', code => {
        if (code !== 0) return reject(new Error(`devcontainer up failed (exit ${code}):\n${stderr}`));
        // With --log-format json each line is a JSON object; find the result line (has "outcome")
        const resultLine = stdout.trim().split('\n')
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .find(o => o && 'outcome' in o);
        if (!resultLine) return reject(new Error(`No result JSON in devcontainer output:\n${stdout}`));
        if (resultLine.outcome !== 'success') {
          return reject(new Error(`devcontainer up outcome: ${resultLine.outcome}\n${stderr}`));
        }
        writeToLog('✓ Devcontainer ready\r\n');
        this.emit('container-log', { projectRoot, message: 'Devcontainer ready' });
        resolve({ containerId: resultLine.containerId, remoteWorkspaceFolder: resultLine.remoteWorkspaceFolder });
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
  var __containerManager: ContainerManager | undefined;
}

export const containerManager: ContainerManager =
  global.__containerManager ?? (global.__containerManager = new ContainerManager());

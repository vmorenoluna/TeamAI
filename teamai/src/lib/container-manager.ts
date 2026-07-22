import { spawn, execFileSync, ChildProcess } from 'child_process';
import crossSpawn from 'cross-spawn';
import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync } from 'fs';
import { EventEmitter } from 'events';
import path from 'path';
import { warn as logWarn, log } from './logger';
import { getToolPath } from './tool-checker';

export type ContainerState = 'stopped' | 'starting' | 'running' | 'restarting' | 'generating' | 'validating';

export interface ValidationStep {
  name: string;
  command: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  output?: string;
  error?: string;
}

interface ContainerRecord {
  projectRoot: string;
  state: ContainerState;
  containerId: string | null;
  remoteWorkspaceFolder: string | null;
  startPromise: Promise<void> | null;
  eventWatcher: ChildProcess | null;
  validationSteps: ValidationStep[];
  validationPromise: Promise<boolean> | null;
}

export interface ContainerInfo {
  containerId: string;
  remoteWorkspaceFolder: string;
}

function devcontainerBin(): string {
  const custom = getToolPath('devcontainer');
  if (custom !== 'devcontainer') return custom;
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
    execFileSync(getToolPath('docker'), ['info'], { stdio: 'ignore', timeout: 2000 });
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

  private _newRecord(projectRoot: string, state: ContainerState): ContainerRecord {
    return {
      projectRoot, state,
      containerId: null, remoteWorkspaceFolder: null,
      startPromise: null, eventWatcher: null,
      validationSteps: [], validationPromise: null,
    };
  }

  async ensureContainer(projectRoot: string, logFile?: string): Promise<ContainerInfo> {
    let record = this.records.get(projectRoot);

    if (!record || record.state === 'stopped') {
      // Before running devcontainer up, check if the container is already running
      // (e.g. after a server restart that cleared the in-memory record)
      const existing = this._findRunningContainerSync(projectRoot);
      if (existing) {
        record = this._newRecord(projectRoot, 'running');
        record.containerId = existing.containerId;
        record.remoteWorkspaceFolder = existing.remoteWorkspaceFolder;
        this.records.set(projectRoot, record);
        this._watchEvents(record);
        return existing;
      }

      record = this._newRecord(projectRoot, 'starting');
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
      const out = execFileSync(getToolPath('docker'), [
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
      const containerId = execFileSync(getToolPath('docker'), [
        'ps', '--filter', `label=${label}`, '--format', '{{.ID}}',
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
      if (!containerId) return null;

      const mountsJson = execFileSync(getToolPath('docker'), [
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
  // Before trusting a cached 'running' record, performs a cheap liveness check to detect
  // containers that died without the event watcher noticing (e.g. Docker Desktop restart, OOM).
  getRunningContainer(projectRoot: string): ContainerInfo | null {
    const r = this.records.get(projectRoot);
    if (r?.state === 'running' && r.containerId && r.remoteWorkspaceFolder) {
      // Liveness check: verify the container is actually still running.
      // docker inspect is a cheap local call (sub-100ms) — well worth avoiding
      // the misdiagnosis of infra failures as git problems downstream.
      if (this._isContainerAlive(r.containerId)) {
        return { containerId: r.containerId, remoteWorkspaceFolder: r.remoteWorkspaceFolder };
      }
      // Container died without the event watcher catching it — transition to stopped
      // and fall through to the scan below. ensureContainer() will handle the restart.
      log('container', `Container for ${projectRoot} is not actually running (stale record) — marking stopped`);
      r.state = 'stopped';
      r.containerId = null;
      r.remoteWorkspaceFolder = null;
      r.eventWatcher?.kill();
      r.eventWatcher = null;
      this._emit(r, 'stopped');
    }
    const info = this._findRunningContainerSync(projectRoot);
    if (info) {
      // Populate the record so subsequent calls skip the Docker scan
      const record = this._newRecord(projectRoot, 'running');
      record.containerId = info.containerId;
      record.remoteWorkspaceFolder = info.remoteWorkspaceFolder;
      this.records.set(projectRoot, record);
    }
    return info;
  }

  /** Check whether a container is actually running via docker inspect. */
  private _isContainerAlive(containerId: string): boolean {
    try {
      const result = execFileSync(getToolPath('docker'), [
        'inspect', '--format', '{{.State.Running}}', containerId,
      ], { encoding: 'utf-8', timeout: 5000 }).trim();
      return result === 'true';
    } catch {
      return false;
    }
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
      log('container', `Started — id=${containerId} workspace=${remoteWorkspaceFolder}`);
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
      // cross-spawn, not child_process.spawn: on Windows the devcontainer CLI
      // is a .cmd shim, which Node (>=18.20/20.12/21.7, CVE-2024-27980) refuses
      // to spawn directly — it throws `spawn EINVAL`. cross-spawn routes .cmd/.bat
      // through cmd.exe with proper metacharacter escaping; on other platforms it
      // behaves identically to child_process.spawn.
      const proc = crossSpawn(devcontainerBin(), args, { stdio: ['ignore', 'pipe', 'pipe'] });
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
    const watcher = spawn(getToolPath('docker'), [
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

    log('container', `Container for ${record.projectRoot} died — attempting one restart`);
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

  // ── Bootstrap & Validation ─────────────────────────────────────────────────

  /**
   * Bootstrap a container for a project: generate devcontainer.json if missing,
   * start the container, and validate it by building + testing the project inside.
   * Called asynchronously from saveContainerConfig when the user enables containers.
   */
  async bootstrapContainer(projectRoot: string): Promise<void> {
    const { analyzeProject, generateDevcontainer } = await import('./devcontainer-generator');

    // ── Step 1: Generate devcontainer.json if missing ────────────────────
    const devCfgPath = path.join(projectRoot, '.devcontainer', 'devcontainer.json');
    if (!existsSync(devCfgPath)) {
      // Emit state directly (no record needed — ensureContainer creates one later)
      this.emit('container-state', { projectRoot, state: 'generating' });

      try {
        const info = analyzeProject(projectRoot);
        this._emitLog(projectRoot, `Detected project type: ${info.type}${info.packageManager ? ` (${info.packageManager})` : ''}`);
        this._emitLog(projectRoot, `Build commands from docs: install="${info.installCommand}" build="${info.buildCommand}" test="${info.testCommand}"`);

        const devCfgDir = path.join(projectRoot, '.devcontainer');
        if (!existsSync(devCfgDir)) mkdirSync(devCfgDir, { recursive: true });
        writeFileSync(devCfgPath, generateDevcontainer(projectRoot, info));
        log('container', `Generated devcontainer.json for ${projectRoot} (type=${info.type})`);
        this._emitLog(projectRoot, `Generated .devcontainer/devcontainer.json for ${info.type} project`);
      } catch (err) {
        logWarn('container', 'Failed to generate devcontainer.json', err);
        this.emit('container-state', { projectRoot, state: 'stopped' });
        return;
      }
    }

    // ── Step 2: Start the container ──────────────────────────────────────
    try {
      await this.ensureContainer(projectRoot);
    } catch (err) {
      logWarn('container', 'Container startup failed during bootstrap', err);
      return;
    }

    // ── Step 3: Validate ─────────────────────────────────────────────────
    await this.validateContainer(projectRoot);
  }

  /**
   * Validate a running container by executing install, build, and test
   * commands inside it via docker exec. Progress streams via container-log
   * events. If validation fails, the UI can retry with an agent.
   */
  async validateContainer(projectRoot: string): Promise<boolean> {
    const record = this.records.get(projectRoot);
    if (!record || !record.containerId) {
      logWarn('container', 'Cannot validate — container not running');
      return false;
    }

    record.state = 'validating';
    this._emit(record, 'validating');
    this._emitLog(projectRoot, 'Validating container — running build and tests…');

    // Discover commands from the generated devcontainer or docs
    const info = await this._getValidationCommands(projectRoot);

    const steps: ValidationStep[] = [
      { name: 'Agent tooling', command: 'claude --version && gh --version && git --version', status: 'pending' },
      { name: 'Install dependencies', command: info.installCommand, status: 'pending' },
      { name: 'Build', command: info.buildCommand, status: 'pending' },
      { name: 'Tests', command: info.testCommand, status: 'pending' },
    ];
    record.validationSteps = steps;

    let allPassed = true;
    for (const step of steps) {
      step.status = 'running';
      this._emitValidation(projectRoot, step);
      this._emitLog(projectRoot, `  ▶ ${step.name}…`);

      try {
        const output = execFileSync(getToolPath('docker'), [
          'exec', '-i', '-w', record.remoteWorkspaceFolder!,
          record.containerId,
          'sh', '-c', step.command,
        ], { encoding: 'utf-8', timeout: 300_000, maxBuffer: 10 * 1024 * 1024 });
        step.status = 'passed';
        step.output = output.slice(-2000); // keep last 2KB for display
        this._emitValidation(projectRoot, step);
        this._emitLog(projectRoot, `  ✓ ${step.name} passed`);
      } catch (err: unknown) {
        const execErr = err as { stderr?: string; stdout?: string; message?: string };
        step.status = 'failed';
        step.error = execErr.stderr || execErr.stdout || execErr.message || String(err);
        step.output = execErr.stdout?.slice(-2000) || '';
        this._emitValidation(projectRoot, step);
        this._emitLog(projectRoot, `  ✗ ${step.name} FAILED`);
        allPassed = false;
        break; // stop on first failure
      }
    }

    if (allPassed) {
      record.state = 'running';
      this._emit(record, 'running');
      this._emitLog(projectRoot, '✓ Container validation complete — all steps passed');
    } else {
      record.state = 'running'; // container is still usable even if validation fails
      this._emit(record, 'running');
      this._emitLog(projectRoot, '✗ Container validation failed — check the logs above for details. The container is running and can be used, but you may need to adjust .devcontainer/devcontainer.json.');
    }

    return allPassed;
  }

  /** Get validation state for the UI to display */
  getValidationSteps(projectRoot: string): ValidationStep[] {
    return this.records.get(projectRoot)?.validationSteps ?? [];
  }

  private async _getValidationCommands(projectRoot: string): Promise<{ installCommand: string; buildCommand: string; testCommand: string }> {
    try {
      const { analyzeProject } = await import('./devcontainer-generator');
      const info = analyzeProject(projectRoot);
      return {
        installCommand: info.installCommand,
        buildCommand: info.buildCommand,
        testCommand: info.testCommand,
      };
    } catch {
      return {
        installCommand: 'npm install',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
      };
    }
  }

  /** Emit a log line to the container-log channel */
  private _emitLog(projectRoot: string, message: string): void {
    this.emit('container-log', { projectRoot, message });
  }

  /** Emit a validation step update */
  private _emitValidation(projectRoot: string, step: ValidationStep): void {
    this.emit('container-validation', { projectRoot, step });
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

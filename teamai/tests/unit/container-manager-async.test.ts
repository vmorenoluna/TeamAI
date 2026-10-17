/**
 * Async Docker behaviour of container-manager: no synchronous child_process calls,
 * checkDockerAvailable / getCachedDockerAvailable cache semantics, and the
 * getState / getRunningContainer / ensureContainer concurrency guarantees.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import path from 'path';

// ── Hoisted mocks ──

type ExecCallback = (err: (Error & { stdout?: string; stderr?: string }) | null, stdout: string, stderr: string) => void;
type ExecHandler = (file: string, args: string[], opts: { timeout?: number }, cb: ExecCallback) => void;

const { mockExecFile, mockSpawn, mockCrossSpawn, mockExistsSync, mockLogWarn, mockLog } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockSpawn: vi.fn(),
  mockCrossSpawn: vi.fn(),
  mockExistsSync: vi.fn(),
  mockLogWarn: vi.fn(),
  mockLog: vi.fn(),
}));

vi.mock('child_process', () => ({
  spawn: mockSpawn,
  execFile: mockExecFile,
  ChildProcess: class MockChildProcess {},
}));
vi.mock('cross-spawn', () => ({ default: mockCrossSpawn }));
vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: vi.fn(() => { throw new Error('ENOENT'); }),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
}));
vi.mock('../../src/lib/logger', () => ({ log: mockLog, error: vi.fn(), warn: mockLogWarn }));
vi.mock('../../src/lib/orchestrator/helpers', () => ({ logToOutput: vi.fn() }));

import {
  ContainerManager,
  checkDockerAvailable,
  getCachedDockerAvailable,
  readContainerConfig,
  _resetDockerAvailableCache,
} from '../../src/lib/container-manager';

// ── Helpers ──

type Reply = string | Error | ((args: string[]) => string | Error | Promise<string | Error>);

/** Install an execFile mock that answers by `docker <subcommand>` (async, via setImmediate). */
function dockerReplies(replies: Record<string, Reply>) {
  const impl: ExecHandler = (_file, args, _opts, cb) => {
    const key = args[0] === 'exec' ? (args.includes('--version') ? 'exec-version' : 'exec-trust') : args[0];
    const reply = replies[key] ?? replies[args[0]] ?? '';
    setImmediate(async () => {
      const r = typeof reply === 'function' ? await reply(args) : reply;
      if (r instanceof Error) cb(Object.assign(r, { stdout: '', stderr: '' }), '', '');
      else cb(null, r, '');
    });
  };
  mockExecFile.mockImplementation(impl);
}

const callsTo = (sub: string) => mockExecFile.mock.calls.filter(c => (c[1] as string[])[0] === sub);
const execCalls = (key: string) => mockExecFile.mock.calls.filter(c => {
  const args = c[1] as string[];
  return args[0] === 'exec' && (key === 'trust' ? args.includes('node') : args.includes('--version'));
});

function createProc() {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

function succeedDevcontainerUp(proc: ReturnType<typeof createProc>, containerId = 'cont-new', folder = '/workspace') {
  proc.stdout.emit('data', Buffer.from(JSON.stringify({ outcome: 'success', containerId, remoteWorkspaceFolder: folder }) + '\n'));
  proc.emit('exit', 0);
}

const WAIT = { timeout: 10_000 };

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFile.mockReset();
  mockSpawn.mockReset();
  mockCrossSpawn.mockReset();
  mockExistsSync.mockReturnValue(false);
  mockSpawn.mockImplementation(() => createProc());
  _resetDockerAvailableCache();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── AC1 ──

describe('AC1: no synchronous child_process calls', () => {
  it('container-manager.ts contains none of execFileSync, execSync, spawnSync', async () => {
    const { readFileSync } = await vi.importActual<typeof import('fs')>('fs');
    const src = readFileSync(path.join(__dirname, '../../src/lib/container-manager.ts'), 'utf-8');
    expect(src).not.toMatch(/execFileSync/);
    expect(src).not.toMatch(/execSync/);
    expect(src).not.toMatch(/spawnSync/);
  });
});

// ── AC2 ──

describe('AC2: checkDockerAvailable does not block the event loop', () => {
  it('lets setImmediate callbacks run while docker info is pending', async () => {
    let finish: (() => void) | undefined;
    mockExecFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb: ExecCallback) => { finish = () => cb(null, '', ''); });
    const probe = checkDockerAvailable();
    let ticked = false;
    await new Promise<void>(resolve => setImmediate(() => { ticked = true; resolve(); }));
    expect(ticked).toBe(true);
    finish!();
    expect(await probe).toBe(true);
  });
});

// ── AC3–AC8 ──

describe('checkDockerAvailable cache semantics', () => {
  it('AC3: failed docker info resolves false (never rejects), with a 2000ms timeout', async () => {
    dockerReplies({ info: new Error('boom') });
    await expect(checkDockerAvailable()).resolves.toBe(false);
    const opts = mockExecFile.mock.calls[0][2] as { timeout: number };
    expect(mockExecFile.mock.calls[0][1]).toEqual(['info']);
    expect(opts.timeout).toBe(2000);
    expect(mockLogWarn).toHaveBeenCalledWith('container', 'docker info check failed', expect.any(Error));
  });

  it('AC3: a timed-out docker info (killed process) also resolves false', async () => {
    dockerReplies({ info: Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) });
    await expect(checkDockerAvailable()).resolves.toBe(false);
  });

  it('AC4: a positive result is cached for the process lifetime', async () => {
    dockerReplies({ info: '' });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await checkDockerAvailable()).toBe(true);
    vi.setSystemTime(Date.now() + 24 * 3600_000);
    expect(await checkDockerAvailable()).toBe(true);
    expect(callsTo('info')).toHaveLength(1);
  });

  it('AC4: a negative result is cached for 60s, then re-probed; recovery is logged', async () => {
    dockerReplies({ info: new Error('down') });
    vi.useFakeTimers({ toFake: ['Date'] });
    expect(await checkDockerAvailable()).toBe(false);
    vi.setSystemTime(Date.now() + 59_000);
    expect(await checkDockerAvailable()).toBe(false);
    expect(callsTo('info')).toHaveLength(1);

    vi.setSystemTime(Date.now() + 2_000); // now past the 60s TTL
    dockerReplies({ info: '' });
    expect(await checkDockerAvailable()).toBe(true);
    expect(callsTo('info')).toHaveLength(2);
    expect(mockLog).toHaveBeenCalledWith('container', 'Docker is now available — container mode re-enabled');
  });

  it('AC4: the failure warning is logged only once across repeated negative probes', async () => {
    dockerReplies({ info: new Error('down') });
    await checkDockerAvailable();
    await checkDockerAvailable({ force: true });
    expect(mockLogWarn.mock.calls.filter(c => c[1] === 'docker info check failed')).toHaveLength(1);
  });

  it('AC4: force re-probes even when cached', async () => {
    dockerReplies({ info: '' });
    await checkDockerAvailable();
    await checkDockerAvailable({ force: true });
    expect(callsTo('info')).toHaveLength(2);
  });

  it('AC5: concurrent calls (including forced ones) share one docker info probe', async () => {
    dockerReplies({ info: '' });
    const results = await Promise.all([
      checkDockerAvailable(), checkDockerAvailable(), checkDockerAvailable({ force: true }),
    ]);
    expect(results).toEqual([true, true, true]);
    expect(callsTo('info')).toHaveLength(1);
  });

  it('AC6: getCachedDockerAvailable returns false synchronously and starts one background probe', async () => {
    dockerReplies({ info: '' });
    expect(getCachedDockerAvailable()).toBe(false);
    expect(getCachedDockerAvailable()).toBe(false);
    expect(callsTo('info')).toHaveLength(1);
    await vi.waitFor(() => expect(getCachedDockerAvailable()).toBe(true), WAIT);
    expect(callsTo('info')).toHaveLength(1);
  });

  it('AC6: an expired negative cache starts a background re-probe', async () => {
    dockerReplies({ info: new Error('down') });
    vi.useFakeTimers({ toFake: ['Date'] });
    await checkDockerAvailable();
    vi.setSystemTime(Date.now() + 61_000);
    dockerReplies({ info: '' });
    expect(getCachedDockerAvailable()).toBe(false);
    await vi.waitFor(() => expect(callsTo('info')).toHaveLength(2), WAIT);
  });

  it('AC7: readContainerConfig stays synchronous and reads the cache without calling execFile', async () => {
    dockerReplies({ info: '' });
    await checkDockerAvailable();
    mockExecFile.mockClear();
    const result = readContainerConfig('/missing/project');
    expect(result).toEqual({ enabled: true, explicit: false });
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('AC8: the cache is shared across module instances via globalThis', async () => {
    dockerReplies({ info: '' });
    await checkDockerAvailable();
    vi.resetModules();
    const second = await import('../../src/lib/container-manager');
    mockExecFile.mockClear();
    expect(second.getCachedDockerAvailable()).toBe(true);
    expect(await second.checkDockerAvailable()).toBe(true);
    expect(mockExecFile).not.toHaveBeenCalled();
    expect(global.__dockerAvailability?.value).toBe(true);
  });
});

// ── AC9–AC16 ──

describe('ContainerManager async behaviour', () => {
  let cm: ContainerManager;

  beforeEach(() => {
    cm = new ContainerManager();
  });

  it('AC9: getState maps docker ps -a output with a 10000ms timeout', async () => {
    dockerReplies({ ps: 'Up 2 hours\n' });
    expect(await cm.getState('/proj')).toBe('running');
    expect((mockExecFile.mock.calls[0][2] as { timeout: number }).timeout).toBe(10000);
    expect(mockExecFile.mock.calls[0][1]).toEqual(expect.arrayContaining(['ps', '-a']));

    dockerReplies({ ps: 'Exited (0) 5 minutes ago\n' });
    expect(await cm.getState('/proj')).toBe('stopped');
    dockerReplies({ ps: '' });
    expect(await cm.getState('/proj')).toBe('stopped');
    dockerReplies({ ps: new Error('docker down') });
    expect(await cm.getState('/proj')).toBe('stopped');
  });

  function seedRunning(projectRoot: string, containerId = 'old-id') {
    const record = (cm as any)._newRecord(projectRoot, 'running');
    record.containerId = containerId;
    record.remoteWorkspaceFolder = '/workspace';
    (cm as any).records.set(projectRoot, record);
    return record;
  }

  it('AC10: getRunningContainer marks a dead record stopped and returns the scan result', async () => {
    const record = seedRunning('/proj');
    const states: string[] = [];
    cm.on('container-state', (e: { state: string }) => states.push(e.state));
    dockerReplies({
      inspect: (args) => args.includes('{{.State.Running}}')
        ? 'false\n'
        : JSON.stringify([{ Source: '/proj', Destination: '/workspace' }]),
      ps: 'new-id\n',
    });
    const info = await cm.getRunningContainer('/proj');
    expect(info).toEqual({ containerId: 'new-id', remoteWorkspaceFolder: '/workspace' });
    expect(record.state).toBe('stopped');
    expect(states).toContain('stopped');
    const replacement = (cm as any).records.get('/proj');
    expect(replacement.containerId).toBe('new-id');
    expect(replacement.state).toBe('running');
  });

  it('AC11: liveness race guard — does not stop a record whose container changed during the check', async () => {
    const record = seedRunning('/proj');
    dockerReplies({
      inspect: (args) => {
        if (args.includes('{{.State.Running}}')) { record.containerId = 'restarted-id'; return 'false\n'; }
        return JSON.stringify([]);
      },
      ps: '',
    });
    await cm.getRunningContainer('/proj');
    expect(record.state).toBe('running');
    expect(record.containerId).toBe('restarted-id');
  });

  it('AC12: a scan result does not overwrite a record created by ensureContainer', async () => {
    let releaseScan: (() => void) | undefined;
    dockerReplies({
      ps: () => new Promise<string>(resolve => { releaseScan = () => resolve('scanned-id\n'); }),
      inspect: JSON.stringify([{ Source: '/proj', Destination: '/workspace' }]),
    });
    const scan = cm.getRunningContainer('/proj');
    await vi.waitFor(() => expect(releaseScan).toBeDefined(), WAIT);
    const ensuredRecord = (cm as any)._newRecord('/proj', 'starting');
    (cm as any).records.set('/proj', ensuredRecord);
    releaseScan!();
    const info = await scan;
    expect(info).toEqual({ containerId: 'scanned-id', remoteWorkspaceFolder: '/workspace' });
    expect((cm as any).records.get('/proj')).toBe(ensuredRecord);
    expect(ensuredRecord.state).toBe('starting');
  });

  it('AC13: concurrent ensureContainer calls run one scan and one devcontainer up', async () => {
    const proc = createProc();
    mockCrossSpawn.mockReturnValue(proc);
    dockerReplies({ ps: '', exec: '' });
    const calls = [cm.ensureContainer('/proj'), cm.ensureContainer('/proj'), cm.ensureContainer('/proj')];
    await vi.waitFor(() => expect(mockCrossSpawn).toHaveBeenCalled(), WAIT);
    succeedDevcontainerUp(proc);
    const results = await Promise.all(calls);
    expect(results.every(r => r.containerId === 'cont-new')).toBe(true);
    expect(callsTo('ps')).toHaveLength(1);
    expect(mockCrossSpawn).toHaveBeenCalledTimes(1);
    expect(execCalls('trust')).toHaveLength(1);
  });

  it('AC14: a trust failure rejects, leaves the record stopped, emits stopped, and uses a 10000ms timeout', async () => {
    const proc = createProc();
    mockCrossSpawn.mockReturnValue(proc);
    dockerReplies({ ps: '', 'exec-version': 'v1\n', 'exec-trust': new Error('permission denied') });
    const states: string[] = [];
    cm.on('container-state', (e: { state: string }) => states.push(e.state));
    const result = cm.ensureContainer('/proj');
    const assertion = expect(result).rejects.toThrow(/Failed to record workspace trust for \/workspace in container cont-new: .*permission denied/);
    await vi.waitFor(() => expect(mockCrossSpawn).toHaveBeenCalled(), WAIT);
    succeedDevcontainerUp(proc);
    await assertion;
    expect((cm as any).records.get('/proj').state).toBe('stopped');
    expect(states).toContain('stopped');
    expect((execCalls('trust')[0][2] as { timeout: number }).timeout).toBe(10000);
  });

  it('AC15: trust of an adopted container is retried on the second ensureContainer', async () => {
    let trustAttempts = 0;
    dockerReplies({
      ps: 'adopted-id\n',
      inspect: JSON.stringify([{ Source: '/proj', Destination: '/workspace' }]),
      'exec-trust': () => (++trustAttempts === 1 ? new Error('first attempt fails') : ''),
    });
    await expect(cm.ensureContainer('/proj')).rejects.toThrow(/Failed to record workspace trust/);
    const record = (cm as any).records.get('/proj');
    expect(record.state).toBe('running');
    expect(record.trusted).toBe(false);

    await expect(cm.ensureContainer('/proj')).resolves.toEqual({ containerId: 'adopted-id', remoteWorkspaceFolder: '/workspace' });
    expect(record.trusted).toBe(true);
    expect(trustAttempts).toBe(2);
    expect(mockCrossSpawn).not.toHaveBeenCalled();
  });

  it('AC15: adopting a container emits no starting event', async () => {
    dockerReplies({
      ps: 'adopted-id\n',
      inspect: JSON.stringify([{ Source: '/proj', Destination: '/workspace' }]),
    });
    const states: string[] = [];
    cm.on('container-state', (e: { state: string }) => states.push(e.state));
    await cm.ensureContainer('/proj');
    expect(states).not.toContain('starting');
  });

  it('AC16: a claude --version failure is best-effort and logged', async () => {
    const proc = createProc();
    mockCrossSpawn.mockReturnValue(proc);
    dockerReplies({ ps: '', 'exec-version': new Error('no claude'), 'exec-trust': '' });
    const logs: string[] = [];
    cm.on('container-log', (e: { message: string }) => logs.push(e.message));
    const result = cm.ensureContainer('/proj');
    await vi.waitFor(() => expect(mockCrossSpawn).toHaveBeenCalled(), WAIT);
    succeedDevcontainerUp(proc);
    await expect(result).resolves.toMatchObject({ containerId: 'cont-new' });
    expect(mockLogWarn).toHaveBeenCalledWith('container', expect.stringContaining('Failed to check claude-code version'), expect.any(Error));
    expect((execCalls('version')[0][2] as { timeout: number }).timeout).toBe(5000);
    expect(logs.some(m => m.includes('claude-code'))).toBe(false);
  });
});

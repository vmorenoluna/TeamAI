/**
 * Shared helper for mocking `child_process.execFile` in unit tests.
 *
 * The orchestrator's git helpers call `promisify(execFile)`. Node's real
 * `execFile` carries a `util.promisify.custom` implementation resolving
 * `{ stdout, stderr }`; a bare `vi.fn()` does not, so this helper attaches an
 * equivalent one. The mock behaves like node: the callback receives
 * `(err, stdout, stderr)`, the returned fake child has `stdin.end()`, and a
 * failure is an Error whose message is `Command failed: <cmd>\n<stderr>` with
 * `stdout` / `stderr` properties.
 *
 * Usage (vi.mock is hoisted, so create the mock with vi.hoisted):
 *
 *   const h = await vi.hoisted(async () => {
 *     const { createExecFileMock } = await import('../utils/mock-child-process');
 *     return { exec: createExecFileMock({ handler: () => 'out' }) };
 *   });
 *   vi.mock('child_process', async (orig) => {
 *     const { buildChildProcessMock } = await import('../utils/mock-child-process');
 *     return buildChildProcessMock(await orig(), h.exec);
 *   });
 *
 * Change behaviour per test with `h.exec` options via createExecFileMock's
 * `handler` closure (e.g. a mutable function variable).
 */
import { vi, type Mock } from 'vitest';
import { promisify } from 'util';

export interface ExecFileResult {
  stdout?: string;
  stderr?: string;
}

/** Handler deciding the outcome of one call; throw / return a rejection to fail. */
export type ExecFileHandler = (
  file: string,
  args: string[],
  options: Record<string, unknown>,
) => ExecFileResult | string | void | Promise<ExecFileResult | string | void>;

export interface ExecFileMockOptions {
  /** Handler run for every call; defaults to succeeding with empty output. */
  handler?: ExecFileHandler;
  /**
   * An `execFileSync` mock to delegate to (e.g. when the code under test is
   * still sync elsewhere): its return value becomes stdout, a throw a failure.
   */
  execFileSync?: (file: string, args: string[], options: Record<string, unknown>) => unknown;
  /**
   * Return a plain function instead of a `vi.fn`, so `vi.resetAllMocks()` /
   * `mockReset()` in a test's `beforeEach` cannot wipe its implementation (a
   * reset `vi.fn` never calls back, which hangs every awaited git call).
   * Pair with an `execFileSync` delegate that is itself a `vi.fn` to assert calls.
   */
  resetSafe?: boolean;
}

export type ExecFileMock = Mock;

/** Build the failure Error node's execFile would produce. */
export function execFileError(file: string, args: string[], stderr: string, stdout = ''): Error {
  const err = new Error(`Command failed: ${file} ${args.join(' ')}\n${stderr}`) as Error & {
    stdout: string;
    stderr: string;
    code: number;
  };
  err.stdout = stdout;
  err.stderr = stderr;
  err.code = 1;
  return err;
}

function normalise(r: ExecFileResult | string | void): { stdout: string; stderr: string } {
  if (typeof r === 'string') return { stdout: r, stderr: '' };
  return { stdout: r?.stdout ?? '', stderr: r?.stderr ?? '' };
}

/** A node-style `execFile` mock (callback + promisify.custom). Not yet installed anywhere. */
export function createExecFileMock(options: ExecFileMockOptions = {}): ExecFileMock {
  const run = async (file: string, args: string[], opts: Record<string, unknown>) => {
    if (options.execFileSync) {
      const out = await options.execFileSync(file, args, opts);
      if (out && typeof out === 'object' && 'stdout' in out) return normalise(out as ExecFileResult);
      return normalise(typeof out === 'string' ? out : out == null ? '' : String(out));
    }
    return normalise(await options.handler?.(file, args, opts));
  };

  const impl = (file: string, args: string[], ...rest: unknown[]) => {
    const cb = rest[rest.length - 1] as ((e: Error | null, stdout?: string, stderr?: string) => void) | undefined;
    const opts = (rest.length > 1 ? rest[0] : {}) as Record<string, unknown>;
    run(file, args, opts).then(
      r => cb?.(null, r.stdout, r.stderr),
      (e: unknown) => cb?.(e instanceof Error ? e : new Error(String(e))),
    );
    return { stdin: { end: options.resetSafe ? () => undefined : vi.fn() } };
  };
  const mock = (options.resetSafe ? impl : vi.fn(impl)) as typeof impl;

  // promisify(execFile) must resolve { stdout, stderr } with a `.child`; route it
  // through the callback form so each call is recorded and run exactly once.
  (mock as unknown as Record<symbol, unknown>)[promisify.custom] = (file: string, args: string[], opts: Record<string, unknown> = {}) => {
    let child: unknown;
    const p = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      child = mock(file, args, opts, (e: Error | null, stdout?: string, stderr?: string) =>
        e ? reject(e) : resolve({ stdout: stdout ?? '', stderr: stderr ?? '' }));
    }) as Promise<{ stdout: string; stderr: string }> & { child?: unknown };
    p.child = child;
    return p;
  };
  return mock as unknown as ExecFileMock;
}

/**
 * Module object for `vi.mock('child_process', ...)`: the original module with
 * `execFile` replaced by `execFileMock`.
 */
export function buildChildProcessMock(
  actual: typeof import('child_process'),
  execFileMock: ExecFileMock,
): typeof import('child_process') {
  return { ...actual, execFile: execFileMock as unknown as typeof actual.execFile, default: { ...actual, execFile: execFileMock } } as typeof import('child_process');
}

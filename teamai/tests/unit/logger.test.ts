import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// We need to import the logger module fresh for each test to control NODE_ENV
// Use dynamic import with module reset

const importLogger = async () => {
  // Clear module cache to pick up current NODE_ENV
  vi.resetModules();
  return import('@/lib/logger');
};

describe('logger', () => {
   
  let consoleLogSpy: any;
   
  let consoleWarnSpy: any;
   
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  // ── In development mode ──────────────────────────────────────────────────

  describe('in development (NODE_ENV !== production)', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'development');
    });

    describe('log', () => {
      it('logs message with module prefix', async () => {
        const { log } = await importLogger();
        log('MyModule', 'Hello');
        expect(consoleLogSpy).toHaveBeenCalledWith('[MyModule] Hello');
      });

      it('logs message with additional details', async () => {
        const { log } = await importLogger();
        log('MyModule', 'Hello', { key: 'value' }, 42);
        expect(consoleLogSpy).toHaveBeenCalledWith(
          '[MyModule] Hello',
          { key: 'value' },
          42,
        );
      });

      it('logs message with no details', async () => {
        const { log } = await importLogger();
        log('MyModule', 'Just a message');
        expect(consoleLogSpy).toHaveBeenCalledWith('[MyModule] Just a message');
      });

      it('handles empty module name', async () => {
        const { log } = await importLogger();
        log('', 'No module');
        expect(consoleLogSpy).toHaveBeenCalledWith('[] No module');
      });

      it('handles empty message', async () => {
        const { log } = await importLogger();
        log('Module', '');
        expect(consoleLogSpy).toHaveBeenCalledWith('[Module] ');
      });
    });

    describe('warn', () => {
      it('warns with module prefix', async () => {
        const { warn } = await importLogger();
        warn('MyModule', 'Warning');
        expect(consoleWarnSpy).toHaveBeenCalledWith('[MyModule] Warning');
      });

      it('warns with additional details', async () => {
        const { warn } = await importLogger();
        warn('MyModule', 'Warning', { code: 500 });
        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[MyModule] Warning',
          { code: 500 },
        );
      });

      it('warns with no details', async () => {
        const { warn } = await importLogger();
        warn('MyModule', 'Just a warning');
        expect(consoleWarnSpy).toHaveBeenCalledWith('[MyModule] Just a warning');
      });
    });

    describe('error', () => {
      it('errors with module prefix', async () => {
        const { error } = await importLogger();
        error('MyModule', 'Error occurred');
        expect(consoleErrorSpy).toHaveBeenCalledWith('[MyModule] Error occurred');
      });

      it('errors with Error instance (includes message and stack)', async () => {
        const { error } = await importLogger();
        const err = new Error('Something broke');
        // Reset the spy after import
        consoleErrorSpy.mockClear();
        error('MyModule', 'Error occurred', err);
        expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
        const callArg = consoleErrorSpy.mock.calls[0][0];
        expect(callArg).toBe('[MyModule] Error occurred');
        const detail = consoleErrorSpy.mock.calls[0][1];
        expect(detail).toContain('Something broke');
        expect(detail).toContain('Error');
      });

      it('errors with string detail', async () => {
        const { error } = await importLogger();
        error('MyModule', 'Error occurred', 'extra context');
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[MyModule] Error occurred',
          'extra context',
        );
      });

      it('errors with number detail', async () => {
        const { error } = await importLogger();
        error('MyModule', 'Error code', 404);
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[MyModule] Error code',
          '404',
        );
      });

      it('errors with null detail (no extra arg)', async () => {
        const { error } = await importLogger();
        error('MyModule', 'Error', null);
        // null is not undefined, so it gets stringified
        expect(consoleErrorSpy).toHaveBeenCalledWith(
          '[MyModule] Error',
          'null',
        );
      });

      it('errors with undefined detail (no extra arg)', async () => {
        const { error } = await importLogger();
        error('MyModule', 'Undefined error', undefined);
        expect(consoleErrorSpy).toHaveBeenCalledWith('[MyModule] Undefined error');
      });
    });

    describe('default export', () => {
      it('exports an object with log, warn, error', async () => {
        const logger = await importLogger();
        expect(logger.default).toHaveProperty('log');
        expect(logger.default).toHaveProperty('warn');
        expect(logger.default).toHaveProperty('error');
        expect(typeof logger.default.log).toBe('function');
        expect(typeof logger.default.warn).toBe('function');
        expect(typeof logger.default.error).toBe('function');
      });
    });
  });

  // ── In production mode ────────────────────────────────────────────────────

  describe('in production (NODE_ENV === production)', () => {
    beforeEach(() => {
      vi.stubEnv('NODE_ENV', 'production');
    });

    it('suppresses log in production', async () => {
      const { log } = await importLogger();
      log('MyModule', 'Should not appear');
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('emits warn in production', async () => {
      const { warn } = await importLogger();
      warn('MyModule', 'Crash-recovery warning');
      expect(consoleWarnSpy).toHaveBeenCalledWith('[MyModule] Crash-recovery warning');
    });

    it('still emits error in production', async () => {
      const { error } = await importLogger();
      error('MyModule', 'Critical error');
      expect(consoleErrorSpy).toHaveBeenCalledWith('[MyModule] Critical error');
    });

    it('still emits error with Error instance in production', async () => {
      const { error } = await importLogger();
      const err = new Error('Prod failure');
      consoleErrorSpy.mockClear();
      error('MyModule', 'Critical', err);
      expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
      const detail = consoleErrorSpy.mock.calls[0][1];
      expect(detail).toContain('Prod failure');
    });

    it('log with details also suppressed', async () => {
      const { log } = await importLogger();
      log('MyModule', 'Hidden', { a: 1 });
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('emits warn with details in production', async () => {
      const { warn } = await importLogger();
      warn('MyModule', 'Visible', { b: 2 });
      expect(consoleWarnSpy).toHaveBeenCalledWith('[MyModule] Visible', { b: 2 });
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles Error with no stack trace', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const { error } = await importLogger();
      const err = new Error('No stack');
      // Remove the stack
      delete (err as any).stack;
      error('Module', 'Msg', err);
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Module] Msg',
        'No stack',
      );
    });

    it('handles non-Error objects with message property', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const { error } = await importLogger();
      error('Module', 'Msg', { message: 'custom' });
      // Not an Error instance, so it goes through String() path
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        '[Module] Msg',
        '[object Object]',
      );
    });

    it('handles special characters in module name', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const { log } = await importLogger();
      log('Mod/Sub', 'Test');
      expect(consoleLogSpy).toHaveBeenCalledWith('[Mod/Sub] Test');
    });

    it('handles special characters in message', async () => {
      vi.stubEnv('NODE_ENV', 'development');
      const { log } = await importLogger();
      log('Mod', 'Line 1\nLine 2\tTabbed');
      expect(consoleLogSpy).toHaveBeenCalledWith('[Mod] Line 1\nLine 2\tTabbed');
    });
  });
});

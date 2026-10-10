import { describe, it, expect, afterEach } from 'vitest';
import { forceTestNodeEnv, restoreNodeEnv } from '../node-env';

const env = process.env as Record<string, string | undefined>;

describe('forceTestNodeEnv / restoreNodeEnv', () => {
  const original = env.NODE_ENV;

  afterEach(() => {
    restoreNodeEnv();
    if (original === undefined) delete env.NODE_ENV;
    else env.NODE_ENV = original;
  });

  it('sets NODE_ENV to test and restores the previous value', () => {
    env.NODE_ENV = 'production';
    forceTestNodeEnv();
    expect(env.NODE_ENV).toBe('test');
    restoreNodeEnv();
    expect(env.NODE_ENV).toBe('production');
  });

  it('deletes NODE_ENV on restore when it was originally unset', () => {
    delete env.NODE_ENV;
    forceTestNodeEnv();
    expect(env.NODE_ENV).toBe('test');
    restoreNodeEnv();
    expect('NODE_ENV' in env).toBe(false);
  });

  it('keeps the first saved value when forced twice', () => {
    env.NODE_ENV = 'production';
    forceTestNodeEnv();
    forceTestNodeEnv();
    restoreNodeEnv();
    expect(env.NODE_ENV).toBe('production');
  });

  it('restore is a no-op when nothing was forced', () => {
    env.NODE_ENV = 'development';
    restoreNodeEnv();
    expect(env.NODE_ENV).toBe('development');
  });
});

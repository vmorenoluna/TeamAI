import { describe, it, expect } from 'vitest';
import { MODEL_MIGRATIONS, migrationSignature, migrateProvidersConfig } from '@/lib/providers-migration';

describe('MODEL_MIGRATIONS', () => {
  it('maps exactly the superseded gen-4 opus/sonnet IDs to gen 5', () => {
    expect(MODEL_MIGRATIONS).toEqual({
      'claude-sonnet-4-6': 'claude-sonnet-5',
      'claude-opus-4-8': 'claude-opus-5',
    });
  });

  it('does not migrate current-gen IDs (haiku, fable, gen-5, custom)', () => {
    expect(MODEL_MIGRATIONS['claude-haiku-4-5-20251001']).toBeUndefined();
    expect(MODEL_MIGRATIONS['claude-fable-5']).toBeUndefined();
    expect(MODEL_MIGRATIONS['claude-sonnet-5']).toBeUndefined();
    expect(MODEL_MIGRATIONS['claude-opus-5']).toBeUndefined();
    expect(MODEL_MIGRATIONS['gpt-4o']).toBeUndefined();
  });
});

describe('migrationSignature', () => {
  it('is a stable 8-hex string', () => {
    const sig = migrationSignature();
    expect(sig).toMatch(/^[0-9a-f]{8}$/);
    expect(migrationSignature()).toBe(sig);
  });
});

describe('migrateProvidersConfig', () => {
  it('replaces superseded IDs in default, roles, and exploration with per-ID counts', () => {
    const config = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: {
        analyst: { model: 'claude-opus-4-8' },
        coder: { model: 'claude-sonnet-4-6' },
      },
      exploration: { model: 'claude-sonnet-4-6' },
    };

    const { config: migrated, changes } = migrateProvidersConfig(config);

    expect(migrated.default.model).toBe('claude-sonnet-5');
    expect(migrated.roles!.analyst!.model).toBe('claude-opus-5');
    expect(migrated.roles!.coder!.model).toBe('claude-sonnet-5');
    expect(migrated.exploration!.model).toBe('claude-sonnet-5');

    // Order follows first encounter (default → roles → exploration)
    expect(changes).toEqual([
      { from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', count: 3 },
      { from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 },
    ]);
  });

  it('preserves untouched fields: providers, custom models, current-gen models, roles without overrides', () => {
    const config = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: {
        analyst: { model: 'claude-opus-4-8' },
        coder: { model: 'gpt-4o', provider: 'openai' }, // custom — untouched
        planner: { model: 'claude-haiku-4-5-20251001' }, // current gen — untouched
        merger: {}, // no model override — untouched
      },
      exploration: { model: 'claude-haiku-4-5-20251001' }, // current gen — untouched
    };

    const { config: migrated, changes } = migrateProvidersConfig(config);

    expect(migrated.default).toEqual({ model: 'claude-sonnet-5', provider: 'anthropic' });
    expect(migrated.roles!.analyst).toEqual({ model: 'claude-opus-5' });
    expect(migrated.roles!.coder).toEqual({ model: 'gpt-4o', provider: 'openai' });
    expect(migrated.roles!.planner).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(migrated.roles!.merger).toEqual({});
    expect(migrated.exploration).toEqual({ model: 'claude-haiku-4-5-20251001' });
    expect(changes).toEqual([
      { from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', count: 1 },
      { from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 },
    ]);
  });

  it('does not mutate the input config', () => {
    const config = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: { analyst: { model: 'claude-opus-4-8' } },
    };
    const snapshot = JSON.parse(JSON.stringify(config));

    migrateProvidersConfig(config);

    expect(config).toEqual(snapshot);
  });

  it('is idempotent — migrating a migrated config is a no-op with empty changes', () => {
    const config = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: { analyst: { model: 'claude-opus-4-8' } },
      exploration: { model: 'claude-sonnet-4-6' },
    };

    const once = migrateProvidersConfig(config);
    expect(once.changes).toHaveLength(2);

    const twice = migrateProvidersConfig(once.config);
    expect(twice.changes).toEqual([]);
    expect(twice.config).toEqual(once.config);
  });

  it('returns empty changes and an equal config when nothing is superseded', () => {
    const config = {
      default: { model: 'claude-sonnet-5', provider: 'anthropic' },
      roles: { analyst: { model: 'claude-opus-5' }, planner: { model: 'claude-haiku-4-5-20251001' } },
      exploration: { model: 'claude-fable-5' },
    };

    const { config: migrated, changes } = migrateProvidersConfig(config);

    expect(changes).toEqual([]);
    expect(migrated).toEqual(config);
  });

  it('handles partial configs (no roles / no exploration / empty object)', () => {
    expect(migrateProvidersConfig({ default: { model: 'claude-opus-4-8' } })).toEqual({
      config: { default: { model: 'claude-opus-5' } },
      changes: [{ from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 }],
    });
    expect(migrateProvidersConfig({})).toEqual({ config: {}, changes: [] });
    expect(migrateProvidersConfig({ roles: {} })).toEqual({ config: { roles: {} }, changes: [] });
  });

  it('preserves unknown extra keys on the config and on field objects', () => {
    const config = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic', env: { KEY: 'v' } },
      customTopLevel: 'kept',
    } as unknown as { default: { model: string; provider: string; env: Record<string, string> }; customTopLevel: string };

    const { config: migrated } = migrateProvidersConfig(config);

    expect(migrated.default.env).toEqual({ KEY: 'v' });
    expect((migrated as Record<string, unknown>).customTopLevel).toBe('kept');
  });
});

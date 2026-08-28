import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getProvidersMigrationHint,
  applyProvidersMigration,
  dismissProvidersMigrationHint,
} from '@/app/actions/providers';
import { migrationSignature } from '@/lib/providers-migration';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mocks ───────────────────────────────────────────────────────────────

let mockProjectPath = '';

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: vi.fn(() => Promise.resolve(mockProjectPath)),
}));

const mockRevalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

vi.mock('@/lib/logger', () => ({
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  default: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

// ── Helpers ─────────────────────────────────────────────────────────────

const cfgPath = () => join(mockProjectPath, '.teamai', 'providers.json');
const markerPath = () => join(mockProjectPath, '.teamai', `providers-migration-dismissed-${migrationSignature()}`);

function seedConfig(config: object) {
  mkdirSync(join(mockProjectPath, '.teamai'), { recursive: true });
  writeFileSync(cfgPath(), JSON.stringify(config, null, 2));
}

const SEEDED_STALE_CONFIG = {
  default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
  roles: {
    analyst: { model: 'claude-opus-4-8' },
    planner: { model: 'claude-haiku-4-5-20251001' },
    merger: { model: 'claude-haiku-4-5-20251001' },
  },
  exploration: { model: 'claude-sonnet-4-6' },
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('providers migration actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = join(tmpdir(), `teamai-migration-${randomUUID().slice(0, 8)}`);
    mkdirSync(mockProjectPath, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(mockProjectPath)) {
      try { rmSync(mockProjectPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  // ── getProvidersMigrationHint ───────────────────────────────────────

  it('returns the pending changes when the config contains superseded IDs', async () => {
    seedConfig(SEEDED_STALE_CONFIG);

    const hint = await getProvidersMigrationHint();

    expect(hint).not.toBeNull();
    expect(hint!.changes).toEqual([
      { from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', count: 2 },
      { from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 },
    ]);
  });

  it('returns null when the project has no providers.json (tracks shipped defaults)', async () => {
    const hint = await getProvidersMigrationHint();
    expect(hint).toBeNull();
  });

  it('returns null when the config is already current', async () => {
    seedConfig({
      default: { model: 'claude-sonnet-5', provider: 'anthropic' },
      roles: { analyst: { model: 'claude-opus-5' }, planner: { model: 'claude-haiku-4-5-20251001' } },
      exploration: { model: 'claude-sonnet-5' },
    });

    expect(await getProvidersMigrationHint()).toBeNull();
  });

  it('returns null when no active project is selected', async () => {
    seedConfig(SEEDED_STALE_CONFIG);
    const { getActiveProjectPath } = await import('@/app/actions/projects');
    (getActiveProjectPath as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('No active project'));

    expect(await getProvidersMigrationHint()).toBeNull();
  });

  it('never throws on a corrupted config file', async () => {
    mkdirSync(join(mockProjectPath, '.teamai'), { recursive: true });
    writeFileSync(cfgPath(), '{invalid json');

    expect(await getProvidersMigrationHint()).toBeNull();
  });

  // ── dismissal marker ────────────────────────────────────────────────

  it('dismissal writes a signature-scoped marker and hides the hint', async () => {
    seedConfig(SEEDED_STALE_CONFIG);

    await dismissProvidersMigrationHint();

    expect(existsSync(markerPath())).toBe(true);
    expect(await getProvidersMigrationHint()).toBeNull();
  });

  it('dismissal is scoped to the migration signature — removing the marker re-shows the hint', async () => {
    seedConfig(SEEDED_STALE_CONFIG);
    await dismissProvidersMigrationHint();
    expect(await getProvidersMigrationHint()).toBeNull();

    unlinkSync(markerPath());

    expect(await getProvidersMigrationHint()).not.toBeNull();
  });

  it('dismissal only suppresses the hint — it does not touch the config file', async () => {
    seedConfig(SEEDED_STALE_CONFIG);
    const before = readFileSync(cfgPath(), 'utf-8');

    await dismissProvidersMigrationHint();

    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before);
  });

  // ── applyProvidersMigration ─────────────────────────────────────────

  it('rewrites the on-disk config with migrated IDs and preserves untouched fields', async () => {
    seedConfig(SEEDED_STALE_CONFIG);

    const result = await applyProvidersMigration();

    expect(result.ok).toBe(true);
    expect(result.changes).toEqual([
      { from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', count: 2 },
      { from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 },
    ]);

    const migrated = JSON.parse(readFileSync(cfgPath(), 'utf-8'));
    expect(migrated.default.model).toBe('claude-sonnet-5');
    expect(migrated.roles.analyst.model).toBe('claude-opus-5');
    // Current-gen and custom choices pass through untouched
    expect(migrated.roles.planner.model).toBe('claude-haiku-4-5-20251001');
    expect(migrated.roles.merger.model).toBe('claude-haiku-4-5-20251001');
    expect(migrated.exploration.model).toBe('claude-sonnet-5');
    expect(migrated.default.provider).toBe('anthropic');

    // Cache invalidation for the settings page
    expect(mockRevalidatePath).toHaveBeenCalledWith('/settings');

    // After adopting, the hint naturally disappears
    expect(await getProvidersMigrationHint()).toBeNull();
  });

  it('apply returns ok:false and writes nothing when no superseded IDs exist', async () => {
    seedConfig({
      default: { model: 'claude-sonnet-5', provider: 'anthropic' },
      roles: {},
    });
    const before = readFileSync(cfgPath(), 'utf-8');

    const result = await applyProvidersMigration();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No superseded model IDs');
    expect(readFileSync(cfgPath(), 'utf-8')).toBe(before);
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('apply returns ok:false when no project-level providers file exists', async () => {
    const result = await applyProvidersMigration();

    expect(result.ok).toBe(false);
    expect(result.error).toContain('No project-level providers.json');
    expect(existsSync(cfgPath())).toBe(false);
  });

  it('apply never throws on a corrupted config file', async () => {
    mkdirSync(join(mockProjectPath, '.teamai'), { recursive: true });
    writeFileSync(cfgPath(), '{invalid json');

    await expect(applyProvidersMigration()).resolves.toMatchObject({ ok: false });
  });
});

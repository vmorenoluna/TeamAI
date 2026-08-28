import { createHash } from 'crypto';

/**
 * Superseded Claude model IDs → their current-generation replacements.
 *
 * Projects registered before a defaults bump keep their seeded
 * `.teamai/providers.json` — the drift check in project-store.ts only covers
 * `defaults/commands/*` + `teamai-workflow.md` (by design: a user's saved
 * model choices must never be force-overwritten). This map powers an opt-in
 * Settings hint that offers a targeted migration: replace ONLY the
 * superseded IDs, preserving every other field (custom role overrides,
 * providers, unknown keys, …).
 *
 * When a future default bump supersedes another ID, append it here. The
 * dismissal marker is scoped to a signature of this map's keys, so a new
 * migration re-shows the hint even for users who dismissed an earlier one.
 */
export const MODEL_MIGRATIONS: Record<string, string> = {
  'claude-sonnet-4-6': 'claude-sonnet-5',
  'claude-opus-4-8': 'claude-opus-5',
};

/**
 * Structural subset of the providers config the migration touches. Loose on
 * purpose so it accepts both the on-disk `.teamai/providers.json` shape and
 * the DEFAULT-merged `ProvidersConfig` from the server actions.
 */
export interface MigratableProvidersConfig {
  default?: { model?: string; provider?: string };
  roles?: Record<string, { model?: string; provider?: string } | undefined>;
  exploration?: { model?: string };
}

export interface ModelMigrationChange {
  /** Superseded model ID found in the config. */
  from: string;
  /** Current-generation replacement. */
  to: string;
  /** How many config fields (default / role overrides / exploration) used it. */
  count: number;
}

/**
 * Stable short signature of the current migration map — used to scope the
 * dismissal marker so a future migration re-shows the hint.
 */
export function migrationSignature(): string {
  const keys = Object.keys(MODEL_MIGRATIONS).sort().join(',');
  return createHash('sha256').update(keys).digest('hex').slice(0, 8);
}

/**
 * Return a copy of the config with every superseded model ID replaced by its
 * current replacement, plus a per-ID change summary for display.
 *
 * Never mutates the input. Only `model` fields whose value is a key of
 * MODEL_MIGRATIONS are replaced — custom model IDs, providers, roles without
 * overrides, and unknown fields pass through untouched. Idempotent: migrating
 * an already-migrated config is a no-op with empty changes.
 */
export function migrateProvidersConfig<T extends MigratableProvidersConfig>(config: T): {
  config: T;
  changes: ModelMigrationChange[];
} {
  const changeList = new Map<string, ModelMigrationChange>();
  const record = (from: string, to: string) => {
    const existing = changeList.get(from);
    if (existing) existing.count += 1;
    else changeList.set(from, { from, to, count: 1 });
  };

  /** Replace the model in a single field-config if (and only if) superseded. */
  const swapField = <F extends { model?: string } | undefined>(field: F): F => {
    if (!field) return field;
    const to = field.model ? MODEL_MIGRATIONS[field.model] : undefined;
    if (!to) return field;
    record(field.model as string, to);
    return { ...field, model: to };
  };

  const migrated: T = { ...config };

  if (config.default) {
    migrated.default = swapField(config.default) as T['default'];
  }
  if (config.roles) {
    const roles: NonNullable<T['roles']> = {};
    for (const [role, cfg] of Object.entries(config.roles)) {
      const swapped = swapField(cfg);
      roles[role] = swapped as NonNullable<T['roles']>[string];
    }
    migrated.roles = roles;
  }
  if (config.exploration) {
    migrated.exploration = swapField(config.exploration) as T['exploration'];
  }

  return { config: migrated, changes: [...changeList.values()] };
}

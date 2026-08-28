/**
 * Curated default model lists per provider.
 *
 * These are returned as the initial model list so the dropdown always has
 * options, even without API keys or CLI tools configured. The refresh button
 * will attempt to fetch an up-to-date list from the provider's API/CLI and
 * update the file cache in `.teamai/models-cache.json`.
 *
 * Keep these reasonably current — they're a fallback, not the source of truth.
 */
export const CURATED_MODELS: Record<string, string[]> = {
  anthropic: [
    'claude-fable-5',
    'claude-opus-5',
    'claude-sonnet-5',
    'claude-haiku-4-5-20251001',
  ],
};

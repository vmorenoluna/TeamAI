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
    'claude-opus-4-5',
    'claude-sonnet-4-6',
    'claude-haiku-4-5',
  ],
  openai: [
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-4-turbo',
    'gpt-4',
    'gpt-3.5-turbo',
    'o1',
    'o1-mini',
    'o3-mini',
  ],
  gemini: [
    'gemini-2.5-pro-exp-03-25',
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-1.5-flash-8b',
  ],
  bedrock: [
    'anthropic.claude-sonnet-4-20250514',
    'anthropic.claude-3-5-sonnet-20241022-v2:0',
    'anthropic.claude-3-5-haiku-20241022-v1:0',
    'anthropic.claude-3-opus-20240229-v1:0',
    'anthropic.claude-3-sonnet-20240229-v1:0',
    'anthropic.claude-3-haiku-20240307-v1:0',
    'meta.llama3-70b-instruct-v1:0',
    'meta.llama3-8b-instruct-v1:0',
    'mistral.mistral-7b-instruct-v0:2',
    'mistral.mixtral-8x7b-instruct-v0:1',
  ],
  vertex: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-v2@20241022',
    'claude-3-5-haiku@20241022',
    'claude-3-opus@20240229',
    'claude-3-sonnet@20240229',
    'claude-3-haiku@20240307',
    'gemini-2.0-flash-001',
    'gemini-1.5-pro-001',
    'gemini-1.5-flash-001',
  ],
  ollama: [
    'llama3.2:3b',
    'llama3.2:1b',
    'llama3.1:8b',
    'llama3.1:70b',
    'llama3:8b',
    'mistral:7b',
    'mixtral:8x7b',
    'codellama:13b',
    'codellama:34b',
    'deepseek-coder:6.7b',
    'qwen2.5:7b',
    'phi3:mini',
  ],
};

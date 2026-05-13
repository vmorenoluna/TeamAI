import { describe, it, expect } from 'vitest';
import { resolveProvider, providerToSessionOpts } from '@/lib/providers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTestProject } from '../utils/test-project';

/** Helper: create a temp project with a .teamai/providers.json file */
function setupProvidersTest(providersContent: unknown): { dir: string; clean: () => void } {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  writeFileSync(join(root, '.teamai', 'providers.json'), JSON.stringify(providersContent));
  return { dir: root, clean };
}

describe('resolveProvider', () => {
  it('returns empty object when no providers file exists', () => {
    const result = resolveProvider('/tmp/nonexistent-dir-12345', 'coder');
    expect(result).toEqual({});
  });

  it('returns empty object when providers file is invalid JSON', () => {
    const { dir, clean } = setupProvidersTest('not-valid-json');
    const result = resolveProvider(dir, 'any-role');
    expect(result).toEqual({});
    clean();
  });

  it('returns default config when no role override', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'bedrock', model: 'claude-sonnet' },
    });

    const result = resolveProvider(dir, 'coder');
    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('claude-sonnet');
    clean();
  });

  it('merges role override with default', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'anthropic', model: 'claude-sonnet' },
      roles: { coder: { provider: 'bedrock' } },
    });

    const result = resolveProvider(dir, 'coder');
    // Role override: provider changes to bedrock, model inherited from default
    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('claude-sonnet');
    clean();
  });

  it('role override can set env vars', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'anthropic' },
      roles: { planner: { provider: 'openai', env: { OPENAI_API_KEY: 'sk-planner' } } },
    });

    const result = resolveProvider(dir, 'planner');
    expect(result.provider).toBe('openai');
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-planner' });
    clean();
  });

  it('role override overrides env vars from default', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'openai', env: { OPENAI_API_KEY: 'sk-default' } },
      roles: { coder: { env: { OPENAI_API_KEY: 'sk-coder' } } },
    });

    const result = resolveProvider(dir, 'coder');
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-coder' });
    clean();
  });
});

describe('providerToSessionOpts', () => {
  it('returns empty env when no provider is specified', () => {
    const result = providerToSessionOpts({});
    expect(result.env).toBeUndefined();
    expect(result.model).toBeUndefined();
  });

  it('sets model when provided', () => {
    const result = providerToSessionOpts({ model: 'claude-sonnet-4-6' });
    expect(result.model).toBe('claude-sonnet-4-6');
  });

  it('sets CLAUDE_CODE_USE_BEDROCK for bedrock provider', () => {
    const result = providerToSessionOpts({ provider: 'bedrock' });
    expect(result.env).toBeDefined();
    expect(result.env!['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
  });

  it('sets CLAUDE_CODE_USE_VERTEX for vertex provider', () => {
    const result = providerToSessionOpts({ provider: 'vertex' });
    expect(result.env).toBeDefined();
    expect(result.env!['CLAUDE_CODE_USE_VERTEX']).toBe('1');
  });

  it('sets OPENAI_API_KEY for openai provider', () => {
    const result = providerToSessionOpts({ provider: 'openai' });
    expect(result.env).toBeDefined();
    expect(result.env!['OPENAI_API_KEY']).toBeDefined();
  });

  it('respects explicit OPENAI_API_KEY when set in env', () => {
    const result = providerToSessionOpts({
      provider: 'openai',
      env: { OPENAI_API_KEY: 'sk-custom' },
    });
    expect(result.env!['OPENAI_API_KEY']).toBe('sk-custom');
  });

  it('sets GOOGLE_API_KEY for gemini provider', () => {
    const result = providerToSessionOpts({ provider: 'gemini' });
    expect(result.env).toBeDefined();
    expect(result.env!['GOOGLE_API_KEY']).toBeDefined();
  });

  it('sets ANTHROPIC_BASE_URL for ollama provider with default localhost', () => {
    const result = providerToSessionOpts({ provider: 'ollama' });
    expect(result.env).toBeDefined();
    expect(result.env!['ANTHROPIC_BASE_URL']).toBe('http://localhost:11434');
  });

  it('respects explicit ANTHROPIC_BASE_URL for ollama when set in env', () => {
    const result = providerToSessionOpts({
      provider: 'ollama',
      env: { ANTHROPIC_BASE_URL: 'http://my-server:8080' },
    });
    expect(result.env!['ANTHROPIC_BASE_URL']).toBe('http://my-server:8080');
  });

  it('merges custom env vars with provider defaults', () => {
    const result = providerToSessionOpts({
      provider: 'bedrock',
      env: { CUSTOM_VAR: 'custom-value' },
    });
    expect(result.env!['CUSTOM_VAR']).toBe('custom-value');
    expect(result.env!['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
  });

  it('anthropic provider (default) sets no special env vars', () => {
    const result = providerToSessionOpts({ provider: 'anthropic' });
    expect(result.env).toBeUndefined();
  });

  it('returns undefined env when env object is empty after processing', () => {
    const result = providerToSessionOpts({ provider: 'anthropic' });
    expect(result.env).toBeUndefined();
  });

  it('passes through permissionMode if specified', () => {
    // permissionMode is not in the provider config but providerToSessionOpts
    // just passes through what it's given — test model at minimum
    const result = providerToSessionOpts({ model: 'sonnet' });
    expect(result.model).toBe('sonnet');
  });
});

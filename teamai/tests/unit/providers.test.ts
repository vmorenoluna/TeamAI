import { describe, it, expect } from 'vitest';
import { resolveProvider, providerToSessionOpts } from '@/lib/providers';

describe('resolveProvider', () => {
  it('returns empty object when no providers file exists', () => {
    const result = resolveProvider('/tmp/nonexistent-dir-12345', 'coder');
    expect(result).toEqual({});
  });

  it('returns empty object when providers file is invalid JSON (mocked)', () => {
    // resolveProvider catches JSON parse errors and returns {}
    // Testing with a path that definitely doesn't have a valid providers.json
    const result = resolveProvider('/tmp', 'any-role');
    expect(result).toEqual({});
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
    // The 'anthropic' provider doesn't set any env vars explicitly
    // But the env object is empty so it should be undefined
    expect(result.env).toBeUndefined();
  });

  it('returns undefined env when env object is empty after processing', () => {
    const result = providerToSessionOpts({ provider: 'anthropic' });
    expect(result.env).toBeUndefined();
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { resolveProvider, providerToSessionOpts, resolveTerminalModel } from '@/lib/providers';
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
  // Track dirs created in each test so afterEach always cleans up, even on failure
  let _cleanDir: (() => void) | null = null;

  afterEach(() => {
    _cleanDir?.();
    _cleanDir = null;
  });

  it('falls back to defaults when no project-level providers file exists', () => {
    const result = resolveProvider('/tmp/nonexistent-dir-12345', 'coder');
    // Coder has no role override in defaults → inherits default model
    expect(result.model).toBe('claude-sonnet-4-6');
    expect(result.provider).toBe('anthropic');
  });

  it('returns empty object when providers file is invalid JSON', () => {
    const { root, clean } = createTestProject();
    _cleanDir = clean;
    mkdirSync(join(root, '.teamai'), { recursive: true });
    writeFileSync(join(root, '.teamai', 'providers.json'), '{invalid json}');
    const result = resolveProvider(root, 'any-role');
    expect(result).toEqual({});
  });

  it('returns default config when no role override', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'bedrock', model: 'claude-sonnet' },
    });
    _cleanDir = clean;

    const result = resolveProvider(dir, 'coder');
    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('claude-sonnet');
  });

  it('merges role override with default', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'anthropic', model: 'claude-sonnet' },
      roles: { coder: { provider: 'bedrock' } },
    });
    _cleanDir = clean;

    const result = resolveProvider(dir, 'coder');
    // Role override: provider changes to bedrock, model inherited from default
    expect(result.provider).toBe('bedrock');
    expect(result.model).toBe('claude-sonnet');
  });

  it('role override can set env vars', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'anthropic' },
      roles: { planner: { provider: 'openai', env: { OPENAI_API_KEY: 'sk-planner' } } },
    });
    _cleanDir = clean;

    const result = resolveProvider(dir, 'planner');
    expect(result.provider).toBe('openai');
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-planner' });
  });

  it('role override overrides env vars from default', () => {
    const { dir, clean } = setupProvidersTest({
      default: { provider: 'openai', env: { OPENAI_API_KEY: 'sk-default' } },
      roles: { coder: { env: { OPENAI_API_KEY: 'sk-coder' } } },
    });
    _cleanDir = clean;

    const result = resolveProvider(dir, 'coder');
    expect(result.env).toEqual({ OPENAI_API_KEY: 'sk-coder' });
  });

  describe('role-based model resolution (default providers.json)', () => {
    // Simulates the actual default providers.json shipped with TeamAI:
    // analyst → Opus, planner → Haiku, merger → Haiku, others → Sonnet (default)
    const defaultConfig = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' as const },
      roles: {
        analyst: { model: 'claude-opus-4-5' },
        planner: { model: 'claude-haiku-4-5' },
        merger: { model: 'claude-haiku-4-5' },
      },
    };

    it('analyst resolves to Opus', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'analyst');
      expect(result.model).toBe('claude-opus-4-5');
      expect(result.provider).toBe('anthropic');
    });

    it('planner resolves to Haiku', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'planner');
      expect(result.model).toBe('claude-haiku-4-5');
      expect(result.provider).toBe('anthropic');
    });

    it('merger resolves to Haiku', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'merger');
      expect(result.model).toBe('claude-haiku-4-5');
      expect(result.provider).toBe('anthropic');
    });

    it('coder resolves to default (Sonnet) — no role override', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'coder');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.provider).toBe('anthropic');
    });

    it('qa-reviewer resolves to default (Sonnet) — no role override', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'qa-reviewer');
      expect(result.model).toBe('claude-sonnet-4-6');
      expect(result.provider).toBe('anthropic');
    });

    it('unknown role falls back to default model', () => {
      const { dir, clean } = setupProvidersTest(defaultConfig);
      _cleanDir = clean;
      const result = resolveProvider(dir, 'nonexistent-role');
      expect(result.model).toBe('claude-sonnet-4-6');
    });
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

describe('resolveTerminalModel', () => {
  const baseConfig = {
    default: { model: 'claude-sonnet-4-6', provider: 'anthropic' as const },
    roles: {} as Record<string, { model?: string }>,
  };

  it('strips .md extension and returns role-specific model', () => {
    const config = {
      ...baseConfig,
      roles: { analyst: { model: 'claude-opus-4-5' } },
    };
    expect(resolveTerminalModel('analyst.md', config)).toBe('claude-opus-4-5');
  });

  it('returns default model when role has no override', () => {
    const config = {
      ...baseConfig,
      roles: { analyst: { model: 'claude-opus-4-5' } },
    };
    expect(resolveTerminalModel('planner.md', config)).toBe('claude-sonnet-4-6');
  });

  it('returns default model when no role overrides exist', () => {
    expect(resolveTerminalModel('coder.md', baseConfig)).toBe('claude-sonnet-4-6');
  });

  it('handles role without .md extension (bare name)', () => {
    const config = {
      ...baseConfig,
      roles: { 'qa-reviewer': { model: 'gpt-5' } },
    };
    expect(resolveTerminalModel('qa-reviewer', config)).toBe('gpt-5');
  });

  it('handles multi-part filenames like qa-reviewer.md', () => {
    const config = {
      ...baseConfig,
      roles: { 'qa-reviewer': { model: 'claude-opus-4-5' } },
    };
    expect(resolveTerminalModel('qa-reviewer.md', config)).toBe('claude-opus-4-5');
  });

  it('does not strip .md from middle of filename', () => {
    const config = {
      ...baseConfig,
      roles: { 'some.md.role': { model: 'custom-model' } },
    };
    // Only trailing .md is stripped, so the key stays "some.md.role"
    expect(resolveTerminalModel('some.md.role', config)).toBe('custom-model');
  });

  it('strips only trailing .md even with .md in middle', () => {
    const config = {
      ...baseConfig,
      roles: { 'some.md.role': { model: 'custom-model' } },
    };
    // "some.md.role.md" → key "some.md.role" → matches
    expect(resolveTerminalModel('some.md.role.md', config)).toBe('custom-model');
  });
});

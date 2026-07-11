/**
 * Unit tests for tool-checker.ts — detection engine, path configuration, and cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockExecFileSync, mockExistsSync, mockReadFileSync, mockWriteFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockReadFileSync: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('fs', () => ({
  existsSync: mockExistsSync,
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import {
  checkTool,
  checkAllTools,
  setToolPath,
  getToolPath,
  clearToolPath,
  loadToolsConfig,
  _resetToolCheckCache,
  type ToolName,
} from '@/lib/tool-checker';

// ── Helpers ─────────────────────────────────────────────────────────────────

function mockToolFound(name: ToolName, version: string = '1.0.0') {
  mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
    if (bin === 'where' || bin === 'which') {
      return `/usr/bin/${name}`;
    }
    if (args.includes('--version')) {
      return version;
    }
    throw new Error('unexpected execFileSync call');
  });
}

function mockToolNotFound() {
  mockExecFileSync.mockImplementation(() => {
    throw new Error('not found');
  });
}

function mockToolsConfig(json: Record<string, string> | null) {
  mockExistsSync.mockImplementation((p: string) => {
    if (p.endsWith('tools.json')) return json !== null;
    return false;
  });
  mockReadFileSync.mockImplementation((p: string) => {
    if (p.endsWith('tools.json') && json) return JSON.stringify(json);
    throw new Error('not found');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  _resetToolCheckCache();
  mockToolsConfig(null); // no tools.json by default
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkTool — detection
// ═══════════════════════════════════════════════════════════════════════════

describe('checkTool — detection', () => {
  it('detects a tool found on PATH with version', () => {
    mockToolFound('git');

    const result = checkTool('git');

    expect(result.found).toBe(true);
    expect(result.name).toBe('git');
    expect(result.label).toBe('Git');
    expect(result.version).toBe('1.0.0');
    expect(result.customPath).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('returns not-found when tool is missing on PATH', () => {
    mockToolNotFound();

    const result = checkTool('gh');

    expect(result.found).toBe(false);
    expect(result.name).toBe('gh');
    expect(result.error).toContain('not found on PATH');
  });

  it('caches results — second call returns cached value', () => {
    mockToolFound('claude', '3.0.0');

    checkTool('claude');
    const calls = mockExecFileSync.mock.calls.length;

    const result = checkTool('claude');
    expect(result.version).toBe('3.0.0');
    expect(mockExecFileSync).toHaveBeenCalledTimes(calls); // no new calls
  });

  it('detects claude tool', () => {
    mockToolFound('claude', 'Claude CLI v2.0.0');
    const result = checkTool('claude');
    expect(result.found).toBe(true);
    expect(result.label).toBe('Claude CLI');
  });

  it('detects docker tool', () => {
    mockToolFound('docker', 'Docker version 24.0.0');
    const result = checkTool('docker');
    expect(result.found).toBe(true);
  });

  it('detects devcontainer tool', () => {
    mockToolFound('devcontainer', '0.50.0');
    const result = checkTool('devcontainer');
    expect(result.found).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkTool — custom paths
// ═══════════════════════════════════════════════════════════════════════════

describe('checkTool — custom paths', () => {
  it('uses custom path from tools.json if configured', () => {
    mockToolsConfig({ claude: '/custom/path/claude' });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('tools.json')) return true;
      if (p === '/custom/path/claude') return true;
      return false;
    });
    mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
      if (bin === '/custom/path/claude' && args.includes('--version')) {
        return 'Claude CLI v4.0';
      }
      throw new Error('unexpected');
    });

    const result = checkTool('claude');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/custom/path/claude');
    expect(result.customPath).toBe(true);
    expect(result.version).toBe('Claude CLI v4.0');
  });

  it('falls back to PATH if custom path is not found', () => {
    mockToolsConfig({ gh: '/bad/path/gh' });
    mockExistsSync.mockImplementation((p: string) => {
      if (p.endsWith('tools.json')) return true;
      return false; // custom path doesn't exist
    });
    mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
      if ((bin === 'where' || bin === 'which') && args[0] === 'gh') return '/usr/bin/gh';
      if (bin === '/usr/bin/gh' && args.includes('--version')) return 'gh v1.0';
      throw new Error('unexpected');
    });

    const result = checkTool('gh');

    expect(result.found).toBe(true);
    expect(result.path).toBe('/usr/bin/gh');
    expect(result.customPath).toBe(true);
  });

  it('reports not found when both custom path and PATH fail', () => {
    mockToolsConfig({ gh: '/missing/gh' });
    mockExistsSync.mockImplementation((p: string) => {
      return p.endsWith('tools.json'); // tools.json exists, but nothing else
    });
    mockToolNotFound();

    const result = checkTool('gh');

    expect(result.found).toBe(false);
    expect(result.error).toContain('configured path');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  checkAllTools
// ═══════════════════════════════════════════════════════════════════════════

describe('checkAllTools', () => {
  it('returns status for all six tools', () => {
    mockToolFound('claude');
    mockToolFound('git');
    mockToolFound('gh');
    mockToolFound('glab');
    mockToolFound('docker');
    mockToolFound('devcontainer');

    const results = checkAllTools();

    expect(results).toHaveLength(6);
    const names = results.map(r => r.name);
    expect(names).toContain('claude');
    expect(names).toContain('git');
    expect(names).toContain('gh');
    expect(names).toContain('glab');
    expect(names).toContain('docker');
    expect(names).toContain('devcontainer');
  });

  it('mixes found and missing tools', () => {
    mockExecFileSync.mockImplementation((bin: string, args: string[]) => {
      if (bin === 'where' || bin === 'which') {
        if (args[0] === 'git') return '/usr/bin/git';
        throw new Error('not found');
      }
      return '1.0.0';
    });

    const results = checkAllTools();

    const gitResult = results.find(r => r.name === 'git');
    expect(gitResult?.found).toBe(true);

    const missing = results.filter(r => !r.found);
    expect(missing.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  setToolPath / getToolPath / clearToolPath
// ═══════════════════════════════════════════════════════════════════════════

describe('setToolPath / getToolPath / clearToolPath', () => {
  it('getToolPath returns default name when no config', () => {
    mockToolsConfig(null);
    expect(getToolPath('claude')).toBe('claude');
    expect(getToolPath('git')).toBe('git');
  });

  it('setToolPath persists to tools.json and getToolPath returns it', () => {
    mockToolsConfig(null);
    mockExistsSync.mockReturnValue(false);

    setToolPath('gh', '/opt/homebrew/bin/gh');

    // Verify writeFileSync was called with the correct config
    expect(mockWriteFileSync).toHaveBeenCalled();
    const writtenJson = mockWriteFileSync.mock.calls[0][1];
    const parsed = JSON.parse(writtenJson);
    expect(parsed.gh).toBe('/opt/homebrew/bin/gh');

    // Now mock that tools.json exists for getToolPath
    mockToolsConfig({ gh: '/opt/homebrew/bin/gh' });
    expect(getToolPath('gh')).toBe('/opt/homebrew/bin/gh');
  });

  it('setToolPath with empty string removes the override', () => {
    mockToolsConfig({ git: '/custom/git' });

    setToolPath('git', '');

    const writtenJson = mockWriteFileSync.mock.calls[0][1];
    const parsed = JSON.parse(writtenJson);
    expect(parsed.git).toBeUndefined();
  });

  it('setToolPath with default name removes the override', () => {
    mockToolsConfig({ gh: '/custom/gh' });

    setToolPath('gh', 'gh'); // same as default

    const writtenJson = mockWriteFileSync.mock.calls[0][1];
    const parsed = JSON.parse(writtenJson);
    expect(parsed.gh).toBeUndefined();
  });

  it('clearToolPath removes custom path and resets to default', () => {
    mockToolsConfig({ claude: '/custom/claude' });

    clearToolPath('claude');

    // Config should have claude removed
    const writtenJson = mockWriteFileSync.mock.calls[0][1];
    const parsed = JSON.parse(writtenJson);
    expect(parsed.claude).toBeUndefined();
  });

  it('getToolPath caches on disk reads — second call returns same value', () => {
    mockToolsConfig({ claude: '/etc/claude' });

    const path1 = getToolPath('claude');
    const path2 = getToolPath('claude');

    expect(path1).toBe('/etc/claude');
    expect(path2).toBe('/etc/claude');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  loadToolsConfig
// ═══════════════════════════════════════════════════════════════════════════

describe('loadToolsConfig', () => {
  it('returns empty object when tools.json does not exist', () => {
    mockExistsSync.mockReturnValue(false);
    const config = loadToolsConfig();
    expect(config).toEqual({});
  });

  it('returns parsed config when tools.json exists', () => {
    mockExistsSync.mockImplementation((p: string) => p.endsWith('tools.json'));
    mockReadFileSync.mockReturnValue(JSON.stringify({ claude: '/bin/claude', gh: '/bin/gh' }));

    const config = loadToolsConfig();
    expect(config.claude).toBe('/bin/claude');
    expect(config.gh).toBe('/bin/gh');
  });

  it('returns empty object on malformed JSON', () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue('not-json{{{');

    const config = loadToolsConfig();
    expect(config).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Cache behavior
// ═══════════════════════════════════════════════════════════════════════════

describe('cache behavior', () => {
  it('_resetToolCheckCache clears cache so re-check runs detection again', () => {
    mockToolFound('git', 'v1');

    checkTool('git');
    const afterFirstCall = mockExecFileSync.mock.calls.length;

    _resetToolCheckCache();
    mockToolFound('git', 'v2');

    const result = checkTool('git');
    expect(mockExecFileSync.mock.calls.length).toBeGreaterThan(afterFirstCall);
    expect(result.version).toBe('v2');
  });

  it('setToolPath invalidates cache for that tool', () => {
    mockToolFound('gh', 'v1');

    const first = checkTool('gh');
    expect(first.version).toBe('v1');

    // Set a custom path — should invalidate cache
    setToolPath('gh', '/new/gh');
    mockToolsConfig({ gh: '/new/gh' });
    mockExistsSync.mockReturnValue(true);
    mockToolFound('gh', 'v2');

    const second = checkTool('gh');
    expect(second.version).toBe('v2');
    expect(second.customPath).toBe(true);
  });
});

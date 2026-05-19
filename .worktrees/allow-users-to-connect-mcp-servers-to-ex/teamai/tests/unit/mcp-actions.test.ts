import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: vi.fn() }));

import { getMcpConfig, saveMcpConfig, McpConfig } from '@/app/actions/mcp';
import { getActiveProjectPath } from '@/app/actions/projects';
import { revalidatePath } from 'next/cache';

const mockGetActiveProjectPath = vi.mocked(getActiveProjectPath);
const mockRevalidatePath = vi.mocked(revalidatePath);

function makeTempDir(): { root: string; clean: () => void } {
  const root = join(process.cwd(), '.mcp-test-' + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });
  return { root, clean: () => { if (existsSync(root)) rmSync(root, { recursive: true, force: true }); } };
}

describe('getMcpConfig', () => {
  let clean: () => void;

  afterEach(() => {
    clean?.();
    vi.clearAllMocks();
  });

  it('returns DEFAULT when .mcp.json is absent', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    mockGetActiveProjectPath.mockResolvedValue(root);

    const result = await getMcpConfig();
    expect(result).toEqual({ mcpServers: {} });
  });

  it('returns DEFAULT when .mcp.json contains invalid JSON (AC-12)', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    writeFileSync(join(root, '.mcp.json'), '{not valid json}');
    mockGetActiveProjectPath.mockResolvedValue(root);

    const result = await getMcpConfig();
    expect(result).toEqual({ mcpServers: {} });
  });

  it('returns parsed config when .mcp.json is valid', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    const config: McpConfig = {
      mcpServers: {
        myServer: { command: 'node', args: ['server.js'], type: 'stdio' },
      },
    };
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(config));
    mockGetActiveProjectPath.mockResolvedValue(root);

    const result = await getMcpConfig();
    expect(result).toEqual(config);
  });

  it('returns config with env when .mcp.json includes env vars', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    const config: McpConfig = {
      mcpServers: {
        envServer: { command: 'python', args: ['-m', 'server'], env: { API_KEY: 'secret' }, type: 'stdio' },
      },
    };
    writeFileSync(join(root, '.mcp.json'), JSON.stringify(config));
    mockGetActiveProjectPath.mockResolvedValue(root);

    const result = await getMcpConfig();
    expect(result.mcpServers['envServer'].env).toEqual({ API_KEY: 'secret' });
  });
});

describe('saveMcpConfig', () => {
  let clean: () => void;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    clean?.();
  });

  it('writes config as pretty-printed JSON to <projectRoot>/.mcp.json', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    mockGetActiveProjectPath.mockResolvedValue(root);
    const config: McpConfig = {
      mcpServers: {
        testServer: { command: 'node', type: 'stdio' },
      },
    };

    await saveMcpConfig(config);

    const { readFileSync } = await import('fs');
    const written = readFileSync(join(root, '.mcp.json'), 'utf-8');
    expect(written).toBe(JSON.stringify(config, null, 2));
  });

  it('calls revalidatePath("/settings") after writing', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    mockGetActiveProjectPath.mockResolvedValue(root);

    await saveMcpConfig({ mcpServers: {} });

    expect(mockRevalidatePath).toHaveBeenCalledWith('/settings');
    expect(mockRevalidatePath).toHaveBeenCalledTimes(1);
  });

  it('overwrites existing .mcp.json with new config', async () => {
    const { root, clean: c } = makeTempDir();
    clean = c;
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { old: { command: 'old', type: 'stdio' } } }));
    mockGetActiveProjectPath.mockResolvedValue(root);

    const newConfig: McpConfig = { mcpServers: { newServer: { command: 'new', type: 'stdio' } } };
    await saveMcpConfig(newConfig);

    const { readFileSync } = await import('fs');
    const written = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf-8'));
    expect(written).toEqual(newConfig);
  });
});

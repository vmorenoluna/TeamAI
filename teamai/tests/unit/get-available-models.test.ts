import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAvailableModels } from '@/app/actions/providers';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock child_process preserving other exports (for promisify compat)
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Mock logger to suppress expected error logs
vi.mock('@/lib/logger', () => ({
  error: vi.fn(),
  log: vi.fn(),
  warn: vi.fn(),
  default: { error: vi.fn(), log: vi.fn(), warn: vi.fn() },
}));

describe('getAvailableModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  // ── Unknown provider ────────────────────────────────────────────────

  it('returns error for unknown provider', async () => {
    const result = await getAvailableModels('unknown');
    expect(result.models).toEqual([]);
    expect(result.error).toBe('Unknown provider: unknown');
  });

  // ── Anthropic ───────────────────────────────────────────────────────

  describe('anthropic', () => {
    it('returns error when ANTHROPIC_API_KEY is not set', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '');

      const result = await getAvailableModels('anthropic');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('ANTHROPIC_API_KEY not set');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches and returns sorted model IDs filtered to type=model', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test-anthropic');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'claude-sonnet-4-6', type: 'model', display_name: 'Claude Sonnet 4' },
            { id: 'claude-3-5-sonnet-20241022', type: 'model', display_name: 'Claude 3.5 Sonnet' },
            { id: 'claude-3-opus-20240229', type: 'model', display_name: 'Claude 3 Opus' },
            { id: 'some-embedding', type: 'embedding', display_name: 'Embedding Model' },
          ],
        }),
      });

      const result = await getAvailableModels('anthropic');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual([
        'claude-3-5-sonnet-20241022',
        'claude-3-opus-20240229',
        'claude-sonnet-4-6',
      ]);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'sk-test-anthropic',
            'anthropic-version': '2023-06-01',
          }),
        }),
      );
    });

    it('returns error on API non-ok response', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });

      const result = await getAvailableModels('anthropic');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Anthropic API returned 401');
    });

    it('returns error on network failure', async () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test');
      mockFetch.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));

      const result = await getAvailableModels('anthropic');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Failed to fetch Anthropic models');
    });
  });

  // ── OpenAI ──────────────────────────────────────────────────────────

  describe('openai', () => {
    it('returns error when OPENAI_API_KEY is not set', async () => {
      vi.stubEnv('OPENAI_API_KEY', '');

      const result = await getAvailableModels('openai');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('OPENAI_API_KEY not set');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches and filters to GPT/o1/o3 models only', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test-openai');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            { id: 'gpt-4o' },
            { id: 'gpt-4o-mini' },
            { id: 'gpt-4-turbo' },
            { id: 'text-embedding-3-small' },
            { id: 'whisper-1' },
            { id: 'dall-e-3' },
            { id: 'o1' },
            { id: 'o3-mini' },
          ],
        }),
      });

      const result = await getAvailableModels('openai');

      expect(result.error).toBeUndefined();
      // Alphabetical: gpt-4-turbo < gpt-4o < gpt-4o-mini < o1 < o3-mini
      expect(result.models).toEqual(['gpt-4-turbo', 'gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini']);
      const callUrl = mockFetch.mock.calls[0][0];
      expect(callUrl).toBe('https://api.openai.com/v1/models');
      expect(mockFetch.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-test-openai');
    });

    it('returns error on API failure', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 403 });

      const result = await getAvailableModels('openai');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('OpenAI API returned 403');
    });

    it('returns error on network failure', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'sk-test');
      mockFetch.mockRejectedValueOnce(new Error('timeout'));

      const result = await getAvailableModels('openai');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Failed to fetch OpenAI models');
    });
  });

  // ── Gemini ──────────────────────────────────────────────────────────

  describe('gemini', () => {
    it('returns error when GOOGLE_API_KEY is not set', async () => {
      vi.stubEnv('GOOGLE_API_KEY', '');

      const result = await getAvailableModels('gemini');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('GOOGLE_API_KEY not set');
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches and returns Gemini models with prefix stripped', async () => {
      vi.stubEnv('GOOGLE_API_KEY', 'test-key-gemini');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'models/gemini-2.0-flash' },
            { name: 'models/gemini-1.5-pro' },
            { name: 'models/gemini-1.5-flash' },
            { name: 'models/embedding-001' },
          ],
        }),
      });

      const result = await getAvailableModels('gemini');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual(['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash']);
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('generativelanguage.googleapis.com/v1/models');
      expect(url).toContain('key=test-key-gemini');
    });

    it('returns error on API failure', async () => {
      vi.stubEnv('GOOGLE_API_KEY', 'test-key');
      mockFetch.mockResolvedValueOnce({ ok: false, status: 400 });

      const result = await getAvailableModels('gemini');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Gemini API returned 400');
    });
  });

  // ── Bedrock (CLI-based) ─────────────────────────────────────────────

  describe('bedrock', () => {
    it('returns error when AWS CLI is not available', async () => {
      const { execFile } = await import('child_process');
      (vi.mocked(execFile) as unknown as vi.Mock).mockImplementation((_cmd: string, _args: readonly string[], _opts: object, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
        callback(new Error('AWS CLI not found'), '', '');
      });

      const result = await getAvailableModels('bedrock');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('AWS CLI not available or not configured for Bedrock');
    });
  });

  // ── Vertex (CLI-based) ──────────────────────────────────────────────

  describe('vertex', () => {
    it('returns error when gcloud CLI is not available', async () => {
      const { execFile } = await import('child_process');
      (vi.mocked(execFile) as unknown as vi.Mock).mockImplementation((_cmd: string, _args: readonly string[], _opts: object, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
        callback(new Error('gcloud not found'), '', '');
      });

      const result = await getAvailableModels('vertex');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('gcloud CLI not available or not configured for Vertex AI');
    });
  });

  // ── Ollama ──────────────────────────────────────────────────────────

  describe('ollama', () => {
    it('fetches and returns model names sorted', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          models: [
            { name: 'llama3.2:3b' },
            { name: 'mistral:7b' },
            { name: 'codellama:13b' },
          ],
        }),
      });

      const result = await getAvailableModels('ollama');

      expect(result.error).toBeUndefined();
      expect(result.models).toEqual(['codellama:13b', 'llama3.2:3b', 'mistral:7b']);
      expect(mockFetch.mock.calls[0][0]).toBe('http://localhost:11434/api/tags');
    });

    it('returns error when Ollama API is not reachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('fetch failed'));

      const result = await getAvailableModels('ollama');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Ollama not running on localhost:11434');
    });

    it('returns error when Ollama returns non-ok', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const result = await getAvailableModels('ollama');

      expect(result.models).toEqual([]);
      expect(result.error).toBe('Ollama API returned 500');
    });
  });
});

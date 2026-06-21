/**
 * Unit tests for GitHub server actions.
 *
 * Tests cover startIssueList() (session creation, prompt), parseIssuesFromText()
 * (JSON parsing, edge cases), saveIssuesToFile() (persistence), and
 * importIssues() (kanban task creation). Uses createTestProject() helper
 * and mocked processManager / TaskStore.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import type { GitHubIssue } from '@/app/actions/github';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockGetSession = vi.fn();
const mockKillSession = vi.fn();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
  },
}));

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

const mockRevalidatePath = vi.fn();

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

// ── Imports (must be after mocks) ───────────────────────────────────────────

import { createTestProject } from '../utils/test-project';

// ── Helpers ─────────────────────────────────────────────────────────────────

let root: string;
let clean: () => void;

function resetGlobalSessions() {
  delete (globalThis as Record<string, unknown>).__githubSessions;
}

/** Create a well-formed GitHubIssue for test data. */
function issue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    number: 1,
    title: 'Test issue',
    body: 'Issue body',
    state: 'open',
    labels: ['bug'],
    html_url: 'https://github.com/owner/repo/issues/1',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GitHub server actions', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mkdirSync(join(root, '.teamai'), { recursive: true });
    mockGetActiveProjectPath.mockResolvedValue(root);
    resetGlobalSessions();
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
    resetGlobalSessions();
  });

  // ── cancelGithubIssueListing ─────────────────────────────────────────

  describe('cancelGithubIssueListing', () => {
    it('kills the session and removes from tracking map', async () => {
      mockCreateSession.mockResolvedValue('session-cancel');

      const { startIssueList, cancelGithubIssueListing } = await import('@/app/actions/github');
      await startIssueList();

      const globalSessions: Map<string, string> =
        (globalThis as Record<string, unknown>).__githubSessions as Map<string, string>;
      expect(globalSessions.get(root)).toBe('session-cancel');

      await cancelGithubIssueListing();

      expect(mockKillSession).toHaveBeenCalledWith('session-cancel');
      expect(globalSessions.has(root)).toBe(false);
    });

    it('does not crash when no session exists (idempotent)', async () => {
      const { cancelGithubIssueListing } = await import('@/app/actions/github');
      await expect(cancelGithubIssueListing()).resolves.toBeUndefined();
    });

    it('allows a new session after cancel', async () => {
      mockCreateSession.mockResolvedValueOnce('session-first');
      mockCreateSession.mockResolvedValueOnce('session-second');

      const { startIssueList, cancelGithubIssueListing } = await import('@/app/actions/github');
      await startIssueList();
      await cancelGithubIssueListing();

      const secondId = await startIssueList();
      expect(secondId).toBe('session-second');
    });
  });

  // ── startIssueList ───────────────────────────────────────────────────

  describe('startIssueList', () => {
    it('creates a session with correct parameters for GitHub issue listing', async () => {
      mockCreateSession.mockResolvedValue('session-gh');

      const { startIssueList } = await import('@/app/actions/github');
      const id = await startIssueList();

      expect(id).toBe('session-gh');
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith({
        taskId: `github::${root}`,
        role: 'general',
        cwd: root,
      });
    });

    it('sends a prompt instructing the agent to list open GitHub issues', async () => {
      mockCreateSession.mockResolvedValue('session-prompt');

      const { startIssueList } = await import('@/app/actions/github');
      await startIssueList();

      expect(mockSendMessage).toHaveBeenCalledTimes(1);
      const sentMessage: string = mockSendMessage.mock.calls[0][1];
      expect(sentMessage).toContain('List all open GitHub issues');
      expect(sentMessage).toContain('GitHub MCP server');
      expect(sentMessage).toContain('JSON array');
    });

    it('stores the session in the global sessions map', async () => {
      mockCreateSession.mockResolvedValue('session-store');

      const { startIssueList } = await import('@/app/actions/github');
      await startIssueList();

      const globalSessions: Map<string, string> | undefined =
        (globalThis as Record<string, unknown>).__githubSessions as Map<string, string> | undefined;
      expect(globalSessions).toBeDefined();
      expect(globalSessions!.get(root)).toBe('session-store');
    });

    it('uses the correct project path from getActiveProjectPath', async () => {
      mockCreateSession.mockResolvedValue('session-path');

      const { startIssueList } = await import('@/app/actions/github');
      await startIssueList();

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
      expect(mockCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: root }),
      );
    });

    it('propagates error when createSession fails', async () => {
      mockCreateSession.mockRejectedValue(new Error('process unavailable'));

      const { startIssueList } = await import('@/app/actions/github');
      await expect(startIssueList()).rejects.toThrow('process unavailable');
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { startIssueList } = await import('@/app/actions/github');
      await expect(startIssueList()).rejects.toThrow('no project selected');
    });
  });

  // ── parseIssuesFromText ──────────────────────────────────────────────

  describe('parseIssuesFromText', () => {
    // parseIssuesFromText is a pure function — no side effects needed
    let parseIssuesFromText: (text: string) => GitHubIssue[];

    beforeEach(async () => {
      const mod = await import('@/app/actions/github');
      parseIssuesFromText = mod.parseIssuesFromText;
    });

    it('parses a valid JSON array of GitHub issues', () => {
      const json = JSON.stringify([
        { number: 1, title: 'Bug', body: '', state: 'open', labels: [], html_url: '', created_at: '' },
        { number: 2, title: 'Feature', body: '', state: 'open', labels: [], html_url: '', created_at: '' },
      ]);

      const result = parseIssuesFromText(json);

      expect(result.length).toBe(2);
      expect(result[0].number).toBe(1);
      expect(result[0].title).toBe('Bug');
      expect(result[1].number).toBe(2);
      expect(result[1].title).toBe('Feature');
    });

    // NOTE: parseIssuesFromText uses a greedy regex /\[[\s\S]*\]/ which
    // matches from the first [ to the last ].  Multiple JSON arrays in one
    // string (e.g. [1,2] [3,4]) would be captured as a single block and
    // fail JSON.parse, returning [].  This is expected behaviour per the
    // current implementation.
    it('extracts JSON array from text with surrounding content', () => {
      const text = 'Here are the issues:\n[\n  {"number":1,"title":"Fix","body":"","state":"open","labels":[],"html_url":"","created_at":""}\n]\nDone.';

      const result = parseIssuesFromText(text);

      expect(result.length).toBe(1);
      expect(result[0].number).toBe(1);
      expect(result[0].title).toBe('Fix');
    });

    it('returns empty array when no brackets are present', () => {
      const result = parseIssuesFromText('No JSON here, just plain text.');
      expect(result).toEqual([]);
    });

    it('returns empty array when text is empty', () => {
      const result = parseIssuesFromText('');
      expect(result).toEqual([]);
    });

    it('returns empty array for a JSON object (not array)', () => {
      const result = parseIssuesFromText('{"number": 1, "title": "X"}');
      expect(result).toEqual([]);
    });

    it('returns empty array for malformed JSON inside brackets', () => {
      const result = parseIssuesFromText('[invalid json content here');
      expect(result).toEqual([]);
    });

    it('filters out items with number = 0', () => {
      const json = JSON.stringify([
        { number: 0, title: 'Zero', body: '', state: 'open', labels: [], html_url: '', created_at: '' },
        { number: 5, title: 'Valid', body: '', state: 'open', labels: [], html_url: '', created_at: '' },
      ]);

      const result = parseIssuesFromText(json);

      expect(result.length).toBe(1);
      expect(result[0].number).toBe(5);
    });

    it('defaults missing fields to sensible values', () => {
      const json = JSON.stringify([{ number: 42 }]);

      const result = parseIssuesFromText(json);

      expect(result[0].title).toBe('');
      expect(result[0].body).toBe('');
      expect(result[0].state).toBe('open');
      expect(result[0].labels).toEqual([]);
      expect(result[0].html_url).toBe('');
      expect(result[0].created_at).toBe('');
    });

    it('coerces non-string labels to strings', () => {
      const json = JSON.stringify([
        { number: 1, title: '', body: '', state: '', labels: ['bug', 123, null], html_url: '', created_at: '' },
      ]);

      const result = parseIssuesFromText(json);

      expect(result[0].labels).toEqual(['bug', '123', 'null']);
    });

    it('handles items where labels is not an array', () => {
      const json = JSON.stringify([
        { number: 1, title: '', body: '', state: '', labels: 'bug,feature', html_url: '', created_at: '' },
      ]);

      const result = parseIssuesFromText(json);

      expect(result[0].labels).toEqual([]);
    });
  });

  // ── saveIssuesToFile ─────────────────────────────────────────────────

  describe('saveIssuesToFile', () => {
    let saveIssuesToFile: (sessionId: string, issues: GitHubIssue[]) => Promise<void>;

    beforeEach(async () => {
      const mod = await import('@/app/actions/github');
      saveIssuesToFile = mod.saveIssuesToFile;
    });

    it('writes issues to .teamai/github/issues-{sessionId}.json', async () => {
      const sessionId = 'session-save';
      const issues = [issue({ number: 1 }), issue({ number: 2 })];

      await saveIssuesToFile(sessionId, issues);

      const filePath = join(root, '.teamai', 'github', `issues-${sessionId}.json`);
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.length).toBe(2);
      expect(parsed[0].number).toBe(1);
      expect(parsed[1].number).toBe(2);
    });

    it('creates the .teamai/github directory if it does not exist', async () => {
      // Remove the existing directory to test creation
      const githubDir = join(root, '.teamai', 'github');
      if (existsSync(githubDir)) rmSync(githubDir, { recursive: true, force: true });

      const sessionId = 'session-mkdir';
      await saveIssuesToFile(sessionId, [issue()]);

      expect(existsSync(githubDir)).toBe(true);
    });

    it('writes an empty array when no issues are provided', async () => {
      const sessionId = 'session-empty';
      await saveIssuesToFile(sessionId, []);

      const filePath = join(root, '.teamai', 'github', `issues-${sessionId}.json`);
      expect(existsSync(filePath)).toBe(true);
      const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
      expect(parsed).toEqual([]);
    });

    it('uses the active project path to determine output directory', async () => {
      const sessionId = 'session-path';
      await saveIssuesToFile(sessionId, [issue()]);

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project'));

      await expect(saveIssuesToFile('sid', [issue()])).rejects.toThrow('no project');
    });
  });

  // ── importIssues ─────────────────────────────────────────────────────

  describe('importIssues', () => {
    let importIssues: (issues: GitHubIssue[]) => Promise<{ taskIds: string[] }>;

    beforeEach(async () => {
      const mod = await import('@/app/actions/github');
      importIssues = mod.importIssues;
    });

    it('creates a kanban task for each GitHub issue', async () => {
      const issues = [
        issue({ number: 1, title: 'Bug fix', body: 'Description' }),
        issue({ number: 2, title: 'Feature request', body: 'More details' }),
      ];

      const result = await importIssues(issues);

      expect(result.taskIds.length).toBe(2);
      expect(typeof result.taskIds[0]).toBe('string');
      expect(typeof result.taskIds[1]).toBe('string');
      expect(result.taskIds[0]).not.toBe(result.taskIds[1]);

      // Verify tasks were written to disk via TaskStore
      const specsDir = join(root, '.teamai');
      const taskDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      // TaskStore creates one directory per task (by slug)
      expect(taskDirs.length).toBe(2);
    });

    it('includes GitHub issue metadata in the task description', async () => {
      const issues = [issue({
        number: 42,
        title: 'Critical bug',
        body: 'Steps to reproduce...',
        labels: ['critical', 'frontend'],
        html_url: 'https://github.com/owner/repo/issues/42',
      })];

      await importIssues(issues);

      // Read back the task to verify description content
      const specsDir = join(root, '.teamai');
      const taskDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      expect(taskDirs.length).toBe(1);
      const taskDir = taskDirs[0];
      const taskJson = JSON.parse(readFileSync(join(specsDir, taskDir.name, 'task.json'), 'utf-8'));

      expect(taskJson.title).toBe('Critical bug');
      expect(taskJson.description).toContain('## GitHub Issue #42');
      expect(taskJson.description).toContain('Steps to reproduce...');
      expect(taskJson.description).toContain('**Labels:** critical, frontend');
      expect(taskJson.description).toContain('**URL:** https://github.com/owner/repo/issues/42');
    });

    it('uses "(no description)" when issue body is empty', async () => {
      const issues = [issue({ number: 1, body: '' })];

      await importIssues(issues);

      const specsDir = join(root, '.teamai');
      const taskDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      expect(taskDirs.length).toBe(1);
      const taskJson = JSON.parse(readFileSync(join(specsDir, taskDirs[0].name, 'task.json'), 'utf-8'));
      expect(taskJson.description).toContain('(no description)');
    });

    it('handles issues with no labels gracefully', async () => {
      const issues = [issue({ number: 1, labels: [] })];

      await importIssues(issues);

      const specsDir = join(root, '.teamai');
      const taskDirs = readdirSync(specsDir, { withFileTypes: true })
        .filter(d => d.isDirectory());
      expect(taskDirs.length).toBe(1);
      const taskJson = JSON.parse(readFileSync(join(specsDir, taskDirs[0].name, 'task.json'), 'utf-8'));
      expect(taskJson.description).toContain('**Labels:** none');
    });

    it('returns an empty taskIds array for no issues', async () => {
      const result = await importIssues([]);
      expect(result.taskIds).toEqual([]);
    });

    it('calls revalidatePath to refresh the kanban board', async () => {
      const issues = [issue()];

      await importIssues(issues);

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
    });

    it('uses the active project path', async () => {
      await importIssues([issue()]);
      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project'));

      await expect(importIssues([issue()])).rejects.toThrow('no project');
    });
  });

  // ── Session lifecycle ────────────────────────────────────────────────

  describe('session lifecycle', () => {
    it('subsequent issue lists on the same project create separate sessions', async () => {
      mockCreateSession.mockResolvedValueOnce('session-a');
      mockCreateSession.mockResolvedValueOnce('session-b');

      const { startIssueList } = await import('@/app/actions/github');

      const id1 = await startIssueList();
      expect(id1).toBe('session-a');

      const id2 = await startIssueList();
      expect(id2).toBe('session-b');

      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });

    it('getActiveIssueSession returns null when no session exists', async () => {
      const { getActiveIssueSession } = await import('@/app/actions/github');
      const result = await getActiveIssueSession();
      expect(result).toBeNull();
    });

    it('getActiveIssueSession returns sessionId when running session exists', async () => {
      mockCreateSession.mockResolvedValue('session-running');

      const { startIssueList, getActiveIssueSession } = await import('@/app/actions/github');
      await startIssueList();

      mockGetSession.mockReturnValue({ status: 'running' });
      const result = await getActiveIssueSession();
      expect(result).toBe('session-running');
    });

    it('getActiveIssueSession returns null when session is not running', async () => {
      mockCreateSession.mockResolvedValue('session-dead');

      const { startIssueList, getActiveIssueSession } = await import('@/app/actions/github');
      await startIssueList();

      mockGetSession.mockReturnValue({ status: 'exited' });
      const result = await getActiveIssueSession();
      expect(result).toBeNull();
    });

    it('getActiveIssueSession returns null when session is not found', async () => {
      mockCreateSession.mockResolvedValue('session-gone');

      const { startIssueList, getActiveIssueSession } = await import('@/app/actions/github');
      await startIssueList();

      mockGetSession.mockReturnValue(null);
      const result = await getActiveIssueSession();
      expect(result).toBeNull();
    });
  });
});

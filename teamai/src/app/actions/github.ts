'use server';

import { processManager, containerSessionOpts } from '@/lib/process-manager';
import { TaskStore } from '@/lib/task-store';
import { getActiveProjectPath } from './projects';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';

declare global {
  var __githubSessions: Map<string, string> | undefined;
}
const sessions: Map<string, string> =
  global.__githubSessions ?? (global.__githubSessions = new Map());

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  html_url: string;
  created_at: string;
}

/**
 * Spawn a Claude session that uses the GitHub MCP server to list open issues.
 * The agent is instructed to output ONLY a valid JSON array of issues as text.
 * The component parses this JSON from the stream after the session completes
 * and saves it to a file via saveIssuesToFile.
 */
export async function startIssueList(): Promise<string> {
  const projectPath = await getActiveProjectPath();
  const sessionId = await processManager.createSession({
    taskId: `github::${projectPath}`,
    role: 'general',
    cwd: projectPath,
    ...containerSessionOpts(projectPath),
  });
  sessions.set(projectPath, sessionId);

  const prompt = [
    'List all open GitHub issues for this repository using the GitHub MCP server.',
    'After receiving the results, output ONLY a valid JSON array.',
    'Do not include any other text, markdown formatting, code fences, or backticks.',
    'Each object in the array must have these exact fields:',
    '{ "number": number, "title": string, "body": string, "state": string, "labels": string[], "html_url": string, "created_at": string }',
    'If no issues are found or the GitHub MCP server is not available, output an empty array [].',
  ].join('\n');

  processManager.sendMessage(sessionId, prompt);
  return sessionId;
}

/**
 * Parse a JSON array of GitHub issues from the agent's text output.
 * The regex finds the outermost [...] bracket pair.
 */
export function parseIssuesFromText(text: string): GitHubIssue[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: Record<string, unknown>) => ({
        number: Number(item.number) || 0,
        title: String(item.title || ''),
        body: String(item.body || ''),
        state: String(item.state || 'open'),
        labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
        html_url: String(item.html_url || ''),
        created_at: String(item.created_at || ''),
      }))
      .filter((issue: GitHubIssue) => issue.number > 0);
  } catch {
    return [];
  }
}

/**
 * Save parsed issues to a file for persistence (e.g. after page reload).
 */
export async function saveIssuesToFile(
  sessionId: string,
  issues: GitHubIssue[]
): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const githubDir = join(projectPath, '.teamai', 'github');
  mkdirSync(githubDir, { recursive: true });
  const filePath = join(githubDir, `issues-${sessionId}.json`);
  writeFileSync(filePath, JSON.stringify(issues, null, 2));
}

/**
 * Read issues from the file (used on reconnection after page reload).
 */
export async function getIssuesFromFile(
  sessionId: string
): Promise<GitHubIssue[]> {
  const projectPath = await getActiveProjectPath();
  const filePath = join(projectPath, '.teamai', 'github', `issues-${sessionId}.json`);
  if (!existsSync(filePath)) return [];
  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item: Record<string, unknown>) => ({
        number: Number(item.number) || 0,
        title: String(item.title || ''),
        body: String(item.body || ''),
        state: String(item.state || 'open'),
        labels: Array.isArray(item.labels) ? item.labels.map(String) : [],
        html_url: String(item.html_url || ''),
        created_at: String(item.created_at || ''),
      }))
      .filter((issue: GitHubIssue) => issue.number > 0);
  } catch {
    return [];
  }
}

/**
 * Import multiple GitHub issues as kanban tasks.
 */
export async function importIssues(
  issues: GitHubIssue[]
): Promise<{ taskIds: string[] }> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const taskIds: string[] = [];

  for (const issue of issues) {
    const id = randomUUID();
    const description = [
      `## GitHub Issue #${issue.number}`,
      '',
      issue.body || '(no description)',
      '',
      '---',
      `**Labels:** ${issue.labels.join(', ') || 'none'}`,
      `**URL:** ${issue.html_url}`,
    ].join('\n');
    taskStore.create(id, issue.title, description);
    taskIds.push(id);
  }

  revalidatePath('/');
  return { taskIds };
}

/** Cancel a running GitHub issue listing session. */
export async function cancelGithubIssueListing(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const sessionId = sessions.get(projectPath);
  if (sessionId) {
    processManager.killSession(sessionId);
    sessions.delete(projectPath);
  }
}

/**
 * Check if there's an active GitHub issue listing session for reconnection.
 */
export async function getActiveIssueSession(): Promise<string | null> {
  const projectPath = await getActiveProjectPath();
  const sessionId = sessions.get(projectPath);
  if (!sessionId) return null;
  const session = processManager.getSession(sessionId);
  if (session && session.status === 'running') return sessionId;
  return null;
}

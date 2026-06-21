'use server';

import { processManager } from '@/lib/process-manager';
import { getActiveProjectPath } from './projects';
import { getProvidersConfig } from './providers';
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { TaskStore } from '@/lib/task-store';
import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';

// ── Global session tracking (shared across Next.js module contexts) ──────────
declare global {
   
  var __roadmapSessions: Map<string, string> | undefined;
}
const sessions: Map<string, string> =
  global.__roadmapSessions ?? (global.__roadmapSessions = new Map());

function ensureRoadmapDir(projectPath: string): string {
  const dir = join(projectPath, '.teamai', 'roadmap');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Type definitions (exported so roadmap-view can import them) ──────────────

export interface RoadmapItem {
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  complexity: 1 | 2 | 3 | 4 | 5;
  category: 'Critical Fix' | 'Security' | 'Performance' | 'DX' | 'New Feature' | 'Competitive Response' | 'Infrastructure';
  description: string;
  affected_files: string[];
  source: 'ideation' | 'competitor-analysis';
  competitive_context?: string;
  linkedTaskId?: string;  // set when user converts this item to a kanban ticket
}

export interface RoadmapReport {
  generated_at: string;
  executive_summary: string;
  competitor_analysis_run: boolean;
  competitors?: string[];  // auto-discovered competitor names
  phases: {
    now: RoadmapItem[];
    next: RoadmapItem[];
    later: RoadmapItem[];
    icebox: RoadmapItem[];
    [phase: string]: RoadmapItem[] | undefined;
  };
  items?: RoadmapItem[];
}

// ── Roadmap generation ───────────────────────────────────────────────────────

export async function startRoadmapGeneration(skipCompetitors: boolean = false): Promise<string> {
  const projectPath = await getActiveProjectPath();
  ensureRoadmapDir(projectPath);

  // Find latest ideation report to pass to the roadmap command
  const ideationDir = join(projectPath, '.teamai', 'ideation');
  let ideationArg = '';
  if (existsSync(ideationDir)) {
    const ideationFiles = readdirSync(ideationDir)
      .filter(f => f.startsWith('ideation-') && f.endsWith('.json'))
      .sort()
      .reverse();
    if (ideationFiles.length > 0) {
      ideationArg = ` --ideation-report .teamai/ideation/${ideationFiles[0]}`;
    }
  }

  const providersConfig = await getProvidersConfig();
  const explorationModel = providersConfig.exploration?.model || undefined;
  const sessionId = await processManager.createSession({
    taskId: `roadmap::${projectPath}`,
    role: 'general',
    cwd: projectPath,
    model: explorationModel,
  });
  const key = `roadmap::${projectPath}`;
  sessions.set(key, sessionId);
  const skipFlag = skipCompetitors ? ' --skip-competitors' : '';
  const cmd = `/roadmap${skipFlag}${ideationArg}`;
  processManager.sendMessage(sessionId, cmd);
  return sessionId;
}

// ── Changelog generation ─────────────────────────────────────────────────────

export async function startChangelogGeneration(): Promise<string> {
  const projectPath = await getActiveProjectPath();
  ensureRoadmapDir(projectPath);
  const sessionId = await processManager.createSession({
    taskId: `changelog::${projectPath}`,
    role: 'general',
    cwd: projectPath,
  });
  const key = `changelog::${projectPath}`;
  sessions.set(key, sessionId);
  processManager.sendMessage(sessionId, '/changelog');
  return sessionId;
}

// ── Roadmap reports ──────────────────────────────────────────────────────────

export async function getRoadmapReports(): Promise<{ filename: string; date: string }[]> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai', 'roadmap');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith('roadmap-') && f.endsWith('.json'))
    .map(f => ({ filename: f, date: f.replace('roadmap-', '').replace('.json', '') }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

function partitionFlatItems(items: RoadmapItem[]): RoadmapReport['phases'] {
  const phases: RoadmapReport['phases'] = { now: [], next: [], later: [], icebox: [] };
  const remainingP1: RoadmapItem[] = [];
  const remainingP2: RoadmapItem[] = [];

  for (const item of items) {
    if (item.priority === 'P0') {
      phases.now.push(item);
    } else if (item.priority === 'P1') {
      if (item.complexity <= 2) {
        phases.now.push(item);
      } else {
        remainingP1.push(item);
      }
    } else if (item.priority === 'P2') {
      remainingP2.push(item);
    } else {
      phases.later.push(item);
    }
  }

  // Phase 2 (Next): remaining P1 + high-impact P2
  phases.next = [
    ...remainingP1,
    ...remainingP2.filter(i =>
      i.category === 'Security' || i.category === 'Performance'
    ),
  ];

  // Phase 3 (Later): remaining P2 + P3
  phases.later = [
    ...remainingP2.filter(i =>
      i.category !== 'Security' && i.category !== 'Performance'
    ),
    ...phases.later,
  ];

  return phases;
}

export async function getRoadmapReport(filename: string): Promise<RoadmapReport> {
  const projectPath = await getActiveProjectPath();
  // Validate filename against strict regex (path traversal prevention)
  if (!/^roadmap-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
    throw new Error(`Invalid roadmap filename: ${filename}`);
  }
  const dir = join(projectPath, '.teamai', 'roadmap');
  let raw: RoadmapReport;
  try {
    raw = JSON.parse(readFileSync(join(dir, filename), 'utf-8'));
  } catch {
    throw new Error(`Malformed roadmap JSON: ${filename}`);
  }

  // Normalize: full report with phases
  if (raw.phases && raw.phases.now && raw.phases.next && raw.phases.later && raw.phases.icebox) {
    return {
      generated_at: raw.generated_at ?? '',
      executive_summary: raw.executive_summary ?? '',
      competitor_analysis_run: raw.competitor_analysis_run ?? false,
      competitors: raw.competitors,
      phases: {
        now: raw.phases.now ?? [],
        next: raw.phases.next ?? [],
        later: raw.phases.later ?? [],
        icebox: raw.phases.icebox ?? [],
      },
    };
  }

  // Normalize: flat items with phase field
  const rawItems = raw.items ?? [];
  if (Array.isArray(rawItems) && rawItems.length > 0 && 'phase' in rawItems[0]) {
    const phases: RoadmapReport['phases'] = { now: [], next: [], later: [], icebox: [] };
    for (const item of rawItems as (RoadmapItem & { phase: string })[]) {
      const p = (item.phase ?? 'later').toLowerCase() as keyof RoadmapReport['phases'];
      if (p in phases) phases[p]!.push(item);
    }
    return {
      generated_at: raw.generated_at ?? '',
      executive_summary: raw.executive_summary ?? '',
      competitor_analysis_run: raw.competitor_analysis_run ?? false,
      competitors: raw.competitors,
      phases,
    };
  }

  // Normalize: flat items array
  if (Array.isArray(raw.items)) {
    const phases = partitionFlatItems(raw.items as RoadmapItem[]);
    return {
      generated_at: raw.generated_at ?? '',
      executive_summary: raw.executive_summary ?? '',
      competitor_analysis_run: raw.competitor_analysis_run ?? false,
      competitors: raw.competitors,
      phases,
    };
  }

  // Fallback: try to use as a direct RoadmapReport
  return {
    generated_at: raw.generated_at ?? '',
    executive_summary: raw.executive_summary ?? '',
    competitor_analysis_run: raw.competitor_analysis_run ?? false,
    competitors: raw.competitors,
    phases: raw.phases ?? partitionFlatItems(raw.items ?? []),
  };
}

// ── Changelog reports ────────────────────────────────────────────────────────

export async function getChangelogReports(): Promise<{ filename: string; date: string }[]> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai', 'roadmap');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.startsWith('changelog-') && f.endsWith('.md'))
    .map(f => ({ filename: f, date: f.replace('changelog-', '').replace('.md', '') }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function getLatestChangelog(filename: string): Promise<string> {
  const projectPath = await getActiveProjectPath();
  // Validate filename against strict regex (path traversal prevention)
  if (!/^changelog-\d{4}-\d{2}-\d{2}\.md$/.test(filename)) {
    throw new Error(`Invalid changelog filename: ${filename}`);
  }
  const dir = join(projectPath, '.teamai', 'roadmap');
  return readFileSync(join(dir, filename), 'utf-8');
}

// ── Active session lookup (for reconnect on page mount) ──────────────────────

export async function getActiveRoadmapSession(type: 'roadmap' | 'changelog'): Promise<string | null> {
  const projectPath = await getActiveProjectPath();
  const key = `${type}::${projectPath}`;
  const sessionId = sessions.get(key);
  if (!sessionId) return null;
  const session = processManager.getSession(sessionId);
  if (session && session.status === 'running') return sessionId;
  // Session is gone — clean up the stale entry
  sessions.delete(key);
  return null;
}

/** Verify a stored session ID is still valid (running on the server). */
export async function isRoadmapSessionAlive(sessionId: string): Promise<boolean> {
  const session = processManager.getSession(sessionId);
  return !!(session && session.status === 'running');
}

/** Cancel a running roadmap or changelog generation. */
export async function cancelRoadmapGeneration(type: 'roadmap' | 'changelog'): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const key = `${type}::${projectPath}`;
  const sessionId = sessions.get(key);
  if (sessionId) {
    processManager.killSession(sessionId);
    sessions.delete(key);
  }
}

// ── Convert roadmap item(s) to kanban ticket(s) ─────────────────────────────

const VALID_PHASES: readonly string[] = ['now', 'next', 'later', 'icebox'];

export async function convertToTask(
  filename: string,
  itemIndex: number,
  phaseKey: string,
): Promise<{ taskId: string }> {
  const projectPath = await getActiveProjectPath();
  if (!VALID_PHASES.includes(phaseKey)) throw new Error(`Invalid phase: ${phaseKey}`);
  if (!/^roadmap-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
    throw new Error(`Invalid roadmap filename: ${filename}`);
  }

  const dir = join(projectPath, '.teamai', 'roadmap');
  const filePath = join(dir, filename);
  let report: RoadmapReport;
  try {
    report = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read roadmap file: ${filename}`);
  }

  const items = report.phases?.[phaseKey as keyof typeof report.phases];
  if (!items || !Array.isArray(items) || itemIndex >= items.length) {
    throw new Error(`Item not found at index ${itemIndex} in phase ${phaseKey}`);
  }

  const item = items[itemIndex];
  if (item.linkedTaskId) {
    // Already converted — just return the existing task ID
    return { taskId: item.linkedTaskId };
  }

  // Create a task in the kanban board
  const taskStore = new TaskStore(projectPath);
  const taskId = randomUUID();
  taskStore.create(taskId, item.title, item.description, item.source, item.competitive_context);

  // Write linkedTaskId back to the roadmap JSON
  item.linkedTaskId = taskId;
  writeFileSync(filePath, JSON.stringify(report, null, 2));

  revalidatePath('/');
  revalidatePath('/roadmap');

  return { taskId };
}

export interface ConvertMultipleInput {
  itemIndex: number;
  phaseKey: string;
}

export async function convertMultipleToTasks(
  filename: string,
  items: ConvertMultipleInput[],
): Promise<{ converted: number; skipped: number; taskIds: string[] }> {
  const projectPath = await getActiveProjectPath();
  if (!/^roadmap-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
    throw new Error(`Invalid roadmap filename: ${filename}`);
  }

  const dir = join(projectPath, '.teamai', 'roadmap');
  const filePath = join(dir, filename);
  let report: RoadmapReport;
  try {
    report = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read roadmap file: ${filename}`);
  }

  const taskStore = new TaskStore(projectPath);
  const taskIds: string[] = [];
  let converted = 0;
  let skipped = 0;
  let dirty = false;

  for (const { itemIndex, phaseKey } of items) {
    if (!VALID_PHASES.includes(phaseKey)) continue;
    const phaseItems = report.phases?.[phaseKey];
    if (!phaseItems || !Array.isArray(phaseItems) || itemIndex >= phaseItems.length) continue;

    const item = phaseItems[itemIndex];
    if (item.linkedTaskId) {
      taskIds.push(item.linkedTaskId);
      skipped++;
      continue;
    }

    const taskId = randomUUID();
    taskStore.create(taskId, item.title, item.description, item.source, item.competitive_context);
    item.linkedTaskId = taskId;
    taskIds.push(taskId);
    converted++;
    dirty = true;
  }

  if (dirty) {
    writeFileSync(filePath, JSON.stringify(report, null, 2));
  }

  revalidatePath('/');
  revalidatePath('/roadmap');

  return { converted, skipped, taskIds };
}

// ── Clear linked task ID from a roadmap item ───────────────────────────────

export async function clearLinkedTaskId(
  filename: string,
  itemIndex: number,
  phaseKey: string,
): Promise<void> {
  const projectPath = await getActiveProjectPath();
  if (!VALID_PHASES.includes(phaseKey)) throw new Error(`Invalid phase: ${phaseKey}`);
  if (!/^roadmap-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
    throw new Error(`Invalid roadmap filename: ${filename}`);
  }

  const dir = join(projectPath, '.teamai', 'roadmap');
  const filePath = join(dir, filename);
  let report: RoadmapReport;
  try {
    report = JSON.parse(readFileSync(filePath, 'utf-8')) as RoadmapReport;
  } catch {
    throw new Error(`Cannot read roadmap file: ${filename}`);
  }

  const items = report.phases?.[phaseKey as keyof typeof report.phases];
  if (!items || !Array.isArray(items) || itemIndex >= items.length) {
    throw new Error(`Item not found at index ${itemIndex} in phase ${phaseKey}`);
  }

  // Clear the linkedTaskId
  if (items[itemIndex].linkedTaskId) {
    items[itemIndex].linkedTaskId = undefined;
    writeFileSync(filePath, JSON.stringify(report, null, 2));
    revalidatePath('/');
    revalidatePath('/roadmap');
  }
}

// ── Delete a roadmap item ────────────────────────────────────────────────────

export async function deleteRoadmapItem(
  filename: string,
  itemIndex: number,
  phaseKey: string,
): Promise<void> {
  const projectPath = await getActiveProjectPath();
  if (!VALID_PHASES.includes(phaseKey)) throw new Error(`Invalid phase: ${phaseKey}`);
  if (!/^roadmap-\d{4}-\d{2}-\d{2}\.json$/.test(filename)) {
    throw new Error(`Invalid roadmap filename: ${filename}`);
  }

  const dir = join(projectPath, '.teamai', 'roadmap');
  const filePath = join(dir, filename);
  let report: RoadmapReport;
  try {
    report = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read roadmap file: ${filename}`);
  }

  const items = report.phases?.[phaseKey];
  if (!items || !Array.isArray(items) || itemIndex >= items.length) {
    throw new Error(`Item not found at index ${itemIndex} in phase ${phaseKey}`);
  }

  items.splice(itemIndex, 1);
  writeFileSync(filePath, JSON.stringify(report, null, 2));

  revalidatePath('/');
  revalidatePath('/roadmap');
}

// ── Get statuses of linked kanban tickets ────────────────────────────────────

export async function getLinkedTaskStatuses(
  linkedTaskIds: string[],
): Promise<Record<string, { phase: string; title: string } | null>> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const result: Record<string, { phase: string; title: string } | null> = {};
  for (const id of linkedTaskIds) {
    const task = taskStore.getById(id);
    result[id] = task ? { phase: task.phase, title: task.title } : null;
  }
  return result;
}

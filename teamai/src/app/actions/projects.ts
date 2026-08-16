'use server';

import { projectStore } from '@/lib/project-store';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { readdirSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { error as logError } from '@/lib/logger';

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
}

export async function browseDirectory(dirPath?: string): Promise<BrowseResult> {
  const target = dirPath ?? homedir();
  let entries: { name: string; path: string }[] = [];
  try {
    entries = readdirSync(target, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'node_modules')
      .map(e => ({ name: e.name, path: join(target, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    // Permission denied or invalid path
    logError('projects', 'Failed to read directory', err);
  }
  const parent = dirname(target) !== target ? dirname(target) : null;
  return { path: target, parent, entries };
}

const ACTIVE_PROJECT_COOKIE = 'activeProject';

/**
 * Invalidate both the page and root-layout caches for '/'.
 *
 * In Next.js 16, `revalidatePath('/')` alone may not purge the root layout's
 * RSC payload when called from a server action invoked by a client component
 * inside the layout.  The explicit `'layout'` variant fills that gap.
 */
function revalidateRoot() {
  revalidatePath('/', 'layout');
  revalidatePath('/');
}

// Not async — used synchronously in getStores() in tasks.ts.
// Reads cookies via the synchronous API (available in Next.js server context).
export async function getActiveProjectPath(): Promise<string> {
  const cookieStore = await cookies();
  const path = cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value;
  if (path) return path;
  // No cookie set — auto-select when there's exactly one registered project
  const projects = projectStore.getAll();
  if (projects.length === 1) return projects[0].path;
  throw new Error('No active project selected');
}

export async function getActiveProject() {
  try {
    const path = await getActiveProjectPath();
    return projectStore.getByPath(path);
  } catch {
    return null;
  }
}

export async function setActiveProject(projectPath: string) {
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_PROJECT_COOKIE, projectPath);
  revalidateRoot();
}

export async function addProject(
  formData: FormData,
): Promise<{ error: string } | { ok: true }> {
  const path = formData.get('path') as string;
  const name = formData.get('name') as string | null;
  try {
    projectStore.add(path, name || undefined);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return {
      error: msg === 'already_registered'
        ? 'This project is already registered.'
        : `Failed to add project: ${msg}`,
    };
  }
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_PROJECT_COOKIE, path);
  revalidateRoot();
  return { ok: true };
}

export async function removeProject(projectPath: string) {
  projectStore.remove(projectPath);
  const cookieStore = await cookies();
  if (cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value === projectPath) {
    cookieStore.delete(ACTIVE_PROJECT_COOKIE);
  }
  revalidateRoot();
}

export async function getProjects() {
  return projectStore.getAll();
}

/**
 * Read the persisted startup auto-sync report, or null when nothing changed.
 * Surfaced as an informational banner instead of a click-to-sync prompt.
 */
export async function getDefaultsSyncReport() {
  return projectStore.getDefaultsSyncReport();
}

/** Dismiss the auto-sync banner by removing the persisted report. */
export async function dismissDefaultsSyncReport(): Promise<void> {
  projectStore.dismissDefaultsSyncReport();
  revalidateRoot();
}

/** Sync defaults for a specific project. Returns list of updated file paths. */
export async function syncProjectDefaults(projectPath: string): Promise<string[]> {
  const updated = projectStore.syncDefaults(projectPath);
  if (updated.length > 0) {
    revalidateRoot();
  }
  return updated;
}

/** Result type for the project settings sync-status table. */
export interface ProjectSyncStatus {
  projectName: string;
  projectPath: string;
  /** True when defaults are up to date (no files outdated). */
  upToDate: boolean;
  /** Relative paths of outdated default files. */
  outdatedFiles: string[];
}

/**
 * Get sync status for ALL registered projects (not just stale ones).
 * Uses dry-run syncDefaults per project so files are never modified.
 */
export async function getAllProjectsSyncStatus(): Promise<ProjectSyncStatus[]> {
  const projects = projectStore.getAll();
  const staleMap = new Map(projectStore.getStaleDefaults().map(s => [s.projectPath, s.outdatedFiles]));
  return projects.map(p => {
    const outdated = staleMap.get(p.path) ?? [];
    return {
      projectName: p.name,
      projectPath: p.path,
      upToDate: outdated.length === 0,
      outdatedFiles: outdated,
    };
  });
}

// ── .gitattributes renormalize suggestion ────────────────────────────

const RENORMALIZE_MARKER = 'gitattributes-renormalize-suggestion';

/**
 * If the active project has a pending renormalize suggestion (a one-time
 * prompt to run `git add --renormalize .` after .gitattributes was first
 * added), return its path. Otherwise return null.
 */
export async function getGitattributesRenormalizeSuggestion(): Promise<string | null> {
  try {
    const activePath = await getActiveProjectPath();
    const markerPath = join(activePath, '.teamai', RENORMALIZE_MARKER);
    if (existsSync(markerPath)) return activePath;
    return null;
  } catch {
    return null;
  }
}

/**
 * Dismiss the renormalize suggestion — deletes the marker file so the
 * banner won't reappear on future server restarts.
 */
export async function dismissGitattributesRenormalizeSuggestion(): Promise<void> {
  try {
    const activePath = await getActiveProjectPath();
    const markerPath = join(activePath, '.teamai', RENORMALIZE_MARKER);
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
      revalidateRoot();
    }
  } catch { /* best-effort */ }
}

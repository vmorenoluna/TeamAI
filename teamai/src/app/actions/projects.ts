'use server';

import { projectStore } from '@/lib/project-store';
import { cookies } from 'next/headers';
import { revalidatePath } from 'next/cache';
import { readdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

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
  } catch {
    // Permission denied or invalid path
  }
  const parent = dirname(target) !== target ? dirname(target) : null;
  return { path: target, parent, entries };
}

const ACTIVE_PROJECT_COOKIE = 'activeProject';

// Not async — used synchronously in getStores() in tasks.ts.
// Reads cookies via the synchronous API (available in Next.js server context).
export async function getActiveProjectPath(): Promise<string> {
  const cookieStore = await cookies();
  const path = cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value;
  if (!path) throw new Error('No active project selected');
  return path;
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
  revalidatePath('/');
}

export async function addProject(formData: FormData) {
  const path = formData.get('path') as string;
  const name = formData.get('name') as string | null;
  const project = projectStore.add(path, name || undefined);
  const cookieStore = await cookies();
  cookieStore.set(ACTIVE_PROJECT_COOKIE, path);
  revalidatePath('/');
  return project;
}

export async function removeProject(projectPath: string) {
  projectStore.remove(projectPath);
  const cookieStore = await cookies();
  if (cookieStore.get(ACTIVE_PROJECT_COOKIE)?.value === projectPath) {
    cookieStore.delete(ACTIVE_PROJECT_COOKIE);
  }
  revalidatePath('/');
}

export async function getProjects() {
  return projectStore.getAll();
}

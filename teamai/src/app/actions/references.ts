'use server';

import { mkdirSync, writeFileSync } from 'fs';
import { readdir } from 'fs/promises';
import { randomUUID } from 'crypto';
import { join, extname } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { TaskStore } from '@/lib/task-store';
import { pathExists } from '@/lib/fs-async';

export async function uploadTaskReference(taskId: string, formData: FormData): Promise<string> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const dir = join(await taskStore.getDirByIdAsync(taskId), 'references');
  mkdirSync(dir, { recursive: true });

  const file = formData.get('file') as File | null;
  if (!file) throw new Error('Missing file in form data');
  const ext = extname(file.name) || '.png';
  // randomUUID (not Date.now()) so two uploads in the same millisecond can't
  // collide and silently overwrite each other.
  const dest = join(dir, `ref-${randomUUID()}${ext}`);
  const buffer = Buffer.from(await file.arrayBuffer());
  writeFileSync(dest, buffer);
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return dest;
}

export async function getTaskReferences(taskId: string): Promise<string[]> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  try {
    const dir = join(await taskStore.getDirByIdAsync(taskId), 'references');
    if (!(await pathExists(dir))) return [];
    return (await readdir(dir)).filter(f => /\.(png|jpg|jpeg|webp|gif)$/i.test(f)).sort();
  } catch {
    return [];
  }
}

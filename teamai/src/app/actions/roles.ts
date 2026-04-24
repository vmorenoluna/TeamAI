'use server';

import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

async function getRolesDir(): Promise<string> {
  return join(await getActiveProjectPath(), '.claude', 'roles');
}

export interface RoleDefinition {
  filename: string;
  name: string;
  content: string;
}

export async function getRoles(): Promise<RoleDefinition[]> {
  const dir = await getRolesDir();
  const files = readdirSync(dir).filter(f => f.endsWith('.md'));
  return files.map(filename => {
    const content = readFileSync(join(dir, filename), 'utf-8');
    const nameMatch = content.match(/^#\s+Role:\s+(.+)$/m);
    return {
      filename,
      name: nameMatch ? nameMatch[1] : filename.replace('.md', ''),
      content,
    };
  });
}

export async function getRole(filename: string): Promise<RoleDefinition> {
  const dir = await getRolesDir();
  const content = readFileSync(join(dir, filename), 'utf-8');
  const nameMatch = content.match(/^#\s+Role:\s+(.+)$/m);
  return {
    filename,
    name: nameMatch ? nameMatch[1] : filename.replace('.md', ''),
    content,
  };
}

export async function saveRole(filename: string, content: string): Promise<void> {
  const dir = await getRolesDir();
  const allowedFiles = readdirSync(dir).filter(f => f.endsWith('.md'));
  if (!allowedFiles.includes(filename)) {
    throw new Error(`Unknown role file: ${filename}`);
  }
  writeFileSync(join(dir, filename), content, 'utf-8');
  revalidatePath('/settings');
}

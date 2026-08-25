'use server';

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { writeRoleFile } from '@/lib/role-files';

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
  const files = readdirSync(dir).filter(f => f.endsWith('.md')).sort();
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
  writeRoleFile(dir, filename, content);
  revalidatePath('/settings');
}

export async function resetRole(filename: string): Promise<string> {
  const defaultPath = join(/* turbopackIgnore: true */ process.cwd(), 'defaults', 'roles', filename);
  if (!existsSync(defaultPath)) throw new Error(`No default for ${filename}`);
  const defaultContent = readFileSync(defaultPath, 'utf-8');
  await saveRole(filename, defaultContent);
  return defaultContent;
}

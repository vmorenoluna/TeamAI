/**
 * Shared role-file write helper — the write body of `actions/roles.ts`
 * `saveRole`, extracted so the Role Refinement Assistant can write role files
 * server-side through the exact same validation (filename must already exist
 * in the project's .claude/roles/).
 */
import { readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export function writeRoleFile(rolesDir: string, filename: string, content: string): void {
  const allowedFiles = readdirSync(rolesDir).filter(f => f.endsWith('.md'));
  if (!allowedFiles.includes(filename)) {
    throw new Error(`Unknown role file: ${filename}`);
  }
  writeFileSync(join(rolesDir, filename), content, 'utf-8');
}

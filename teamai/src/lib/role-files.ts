/**
 * Shared role-file write helper — the write body of `actions/roles.ts`
 * `saveRole`, extracted so the Role Refinement Assistant can write role files
 * server-side through the exact same validation (filename must already exist
 * in the project's .claude/roles/).
 */
import { readdirSync, writeFileSync } from 'fs';
import { basename, join } from 'path';

/**
 * Writes a role file, tolerating a caller-supplied `filename` that carries a
 * path prefix (e.g. `.claude/roles/coder.md` instead of `coder.md`) by
 * normalizing to its basename first — this is the single point where a
 * role-file name resolves to a concrete path, so it must be deterministic
 * regardless of what upstream callers pass in.
 */
export function writeRoleFile(rolesDir: string, filename: string, content: string): void {
  const normalized = basename(filename);
  const allowedFiles = readdirSync(rolesDir).filter(f => f.endsWith('.md'));
  if (!allowedFiles.includes(normalized)) {
    throw new Error(`Unknown role file: ${filename}`);
  }
  writeFileSync(join(rolesDir, normalized), content, 'utf-8');
}

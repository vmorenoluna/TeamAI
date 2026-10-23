/**
 * On-disk registry of child processes (agents, terminals) the engine spawned,
 * so a new engine can reap orphans left by a crashed predecessor. Keyed by the
 * server port so concurrent instances do not collide.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

export interface ChildEntry {
  pid: number;
  sessionId: string;
  kind: 'agent' | 'terminal';
}

export function getChildRegistryPath(): string {
  return join(tmpdir(), `teamai-engine-${process.env.PORT}-children.json`);
}

/** Missing or corrupt file -> []. Never throws. */
export function readChildRegistry(): ChildEntry[] {
  try {
    const p = getChildRegistryPath();
    if (!existsSync(p)) return [];
    const parsed: unknown = JSON.parse(readFileSync(p, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as ChildEntry[]) : [];
  } catch {
    return [];
  }
}

export class ChildRegistry {
  private entries = new Map<string, ChildEntry>();

  add(entry: ChildEntry): void {
    this.entries.set(entry.sessionId, entry);
    this.flush();
  }

  remove(sessionId: string): void {
    if (this.entries.delete(sessionId)) this.flush();
  }

  /** Delete the registry file (clean shutdown). */
  clear(): void {
    this.entries.clear();
    try {
      rmSync(getChildRegistryPath(), { force: true });
    } catch { /* best effort */ }
  }

  private flush(): void {
    try {
      writeFileSync(getChildRegistryPath(), JSON.stringify([...this.entries.values()]));
    } catch { /* registry is best effort; never break a spawn */ }
  }
}

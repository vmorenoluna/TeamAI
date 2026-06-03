import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

const CONFIG_DIR = join(homedir(), '.teamai');
const PROJECTS_FILE = join(CONFIG_DIR, 'projects.json');
const BACKUP_FILE = PROJECTS_FILE + '.backup';
const TMP_FILE = PROJECTS_FILE + '.tmp';
// process.cwd() is the project root (teamai/) at runtime
const DEFAULTS_DIR = join(process.cwd(), 'defaults');

export interface Project {
  name: string;
  path: string;
  addedAt: string;
}

/** Result from getStaleDefaults: a project with outdated default files. */
export interface StaleDefaults {
  projectName: string;
  projectPath: string;
  /** Relative paths of defaults that would be updated (uncustomized). */
  outdatedFiles: string[];
}

export class ProjectStore {
  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });

    // ═══ Crash recovery: if a previous add/remove crashed mid-write, ═══
    // the backup still exists. Restore it so the user's data is intact.
    this._restoreFromBackup();

    // Defensive init: only create projects.json if it truly doesn't exist.
    // existsSync can return false temporarily (antivirus, cloud sync, etc.),
    // so we double-check by attempting a read before writing an empty array.
    if (!existsSync(PROJECTS_FILE)) {
      try {
        // If the file actually has content but existsSync lied, this will succeed
        // and we'll see the existing data — don't overwrite it.
        const existing = readFileSync(PROJECTS_FILE, 'utf-8');
        if (existing.trim()) return; // file exists and has content — keep it
      } catch {
        // File truly doesn't exist or is unreadable — create it fresh
      }
      this._atomicWrite(() => []);
    }
  }

  getAll(): Project[] {
    return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
  }

  getByPath(projectPath: string): Project | null {
    return this.getAll().find(p => p.path === projectPath) || null;
  }

  /**
   * Register a new project. Scaffolds .claude/roles/, .claude/commands/,
   * .teamai/, and CLAUDE.md with defaults if they don't already exist.
   */
  add(projectPath: string, name?: string): Project {
    const projects = this.getAll();
    const existing = projects.find(p => p.path === projectPath);

    if (existing) throw new Error('already_registered');

    this.scaffold(projectPath);

    const project: Project = {
      name: name || projectPath.split(/[\\/]/).pop() || projectPath,
      path: projectPath,
      addedAt: new Date().toISOString(),
    };

    projects.push(project);
    this._atomicWrite(() => projects);
    return project;
  }

  remove(projectPath: string): void {
    const projects = this.getAll().filter(p => p.path !== projectPath);
    this._atomicWrite(() => projects);
    // Does NOT delete any files from the project directory
  }

  // ── Atomic write helpers ─────────────────────────────────────────

  /**
   * Write projects atomically: backup → temp file → rename → cleanup.
   * If the process crashes mid-write, the real file is untouched and
   * the next startup restores from the backup.
   */
  private _atomicWrite(compute: () => Project[]): void {
    // 1. Back up current file before modifying
    if (existsSync(PROJECTS_FILE)) {
      writeFileSync(BACKUP_FILE, readFileSync(PROJECTS_FILE, 'utf-8'));
    }

    // 2. Write to temp file (if we crash here, real file is untouched)
    writeFileSync(TMP_FILE, JSON.stringify(compute(), null, 2));

    // 3. Atomically replace real file with temp
    renameSync(TMP_FILE, PROJECTS_FILE);

    // 4. Clean up backup on success
    try { rmSync(BACKUP_FILE); } catch { /* best-effort */ }
  }

  /**
   * Check for a leftover backup from a crashed write and restore it.
   * Called once at startup so the user's project registry is never
   * left in a corrupted or partially-modified state.
   */
  private _restoreFromBackup(): void {
    if (!existsSync(BACKUP_FILE)) return;
    try {
      writeFileSync(PROJECTS_FILE, readFileSync(BACKUP_FILE, 'utf-8'));
      rmSync(BACKUP_FILE);
    } catch {
      // If restore fails, leave backup in place for manual recovery
    }
  }

  // ── Defaults version tracking ────────────────────────────────────

  /** Manifest path for tracking which default versions were copied to a project. */
  private _manifestPath(projectPath: string): string {
    return join(projectPath, '.claude', '.teamai-scaffold.json');
  }

  /** Compute a SHA-256 checksum for content comparison. */
  private _computeChecksum(content: string): string {
    return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
  }

  /**
   * Compute checksums for all default files that get copied into .claude/.
   * Returns a map of relative-path → checksum.
   */
  private _getDefaultsManifest(): Record<string, string> {
    const manifest: Record<string, string> = {};
    const scanDirs = [
      { src: join(DEFAULTS_DIR, 'commands'), prefix: 'commands' },
      { src: join(DEFAULTS_DIR, 'roles'), prefix: 'roles' },
    ];
    for (const { src, prefix } of scanDirs) {
      if (!existsSync(src)) continue;
      for (const file of readdirSync(src)) {
        const relPath = `${prefix}/${file}`;
        manifest[relPath] = this._computeChecksum(readFileSync(join(src, file), 'utf-8'));
      }
    }
    // teamai-workflow.md is a top-level default, not in commands/ or roles/
    const workflowSrc = join(DEFAULTS_DIR, 'teamai-workflow.md');
    if (existsSync(workflowSrc)) {
      manifest['teamai-workflow.md'] = this._computeChecksum(readFileSync(workflowSrc, 'utf-8'));
    }
    return manifest;
  }

  /**
   * Sync default files in a project that have NOT been customized.
   * If a default file was updated in TeamAI and the project's copy still
   * matches the old default (i.e., was never customized), update it.
   *
   * When `dryRun` is true, computes what WOULD be updated but does not
   * write any files. Returns the list of file paths that were (or would
   * be) updated.
   */
  syncDefaults(projectPath: string, dryRun = false): string[] {
    const updated: string[] = [];
    const manifestPath = this._manifestPath(projectPath);

    // Read the stored manifest (what was copied to this project)
    let storedManifest: Record<string, string> = {};
    if (existsSync(manifestPath)) {
      try {
        const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'));
        if (parsed.files) storedManifest = parsed.files;
      } catch { /* malformed — treat as empty */ }
    }

    const currentManifest = this._getDefaultsManifest();
    const newManifest: Record<string, string> = { ...storedManifest };

    for (const [relPath, currentChecksum] of Object.entries(currentManifest)) {
      const storedChecksum = storedManifest[relPath];

      if (!storedChecksum) {
        // New file added in defaults — copy if project doesn't have it.
        // Always record the checksum so future comparisons work even for
        // files that already exist (e.g. in brand-new or old projects).
        newManifest[relPath] = currentChecksum;
        const destFile = join(projectPath, '.claude', relPath);
        if (!existsSync(destFile)) {
          if (!dryRun) {
            const srcFile = join(DEFAULTS_DIR, relPath);
            if (existsSync(srcFile)) cpSync(srcFile, destFile);
          }
          updated.push(relPath);
        }
        continue;
      }

      if (storedChecksum === currentChecksum) {
        // Unchanged — keep the existing entry
        continue;
      }

      // Default changed — check if project's file matches the old default
      const projectFile = join(projectPath, '.claude', relPath);
      if (!existsSync(projectFile)) {
        // File was deleted from project — copy fresh default
        if (!dryRun) {
          const srcFile = join(DEFAULTS_DIR, relPath);
          if (existsSync(srcFile)) cpSync(srcFile, projectFile);
        }
        updated.push(relPath);
        newManifest[relPath] = currentChecksum;
        continue;
      }

      const projectChecksum = this._computeChecksum(readFileSync(projectFile, 'utf-8'));
      if (projectChecksum === storedChecksum) {
        // Project file matches old default — never customized, safe to update
        if (!dryRun) {
          const srcFile = join(DEFAULTS_DIR, relPath);
          if (existsSync(srcFile)) cpSync(srcFile, projectFile);
        }
        updated.push(relPath);
        newManifest[relPath] = currentChecksum;
      } else {
        // Project file was customized — preserve it but update the stored
        // checksum so we don't keep comparing against the old default.
        newManifest[relPath] = currentChecksum;
      }
    }

    // Write updated manifest (skip in dry-run mode)
    if (!dryRun && (updated.length > 0 || Object.keys(storedManifest).length === 0)) {
      try {
        writeFileSync(manifestPath, JSON.stringify({ version: 1, files: newManifest }, null, 2));
      } catch { /* best-effort */ }
    }

    return updated;
  }

  /**
   * Check all registered projects for stale default files that could be
   * updated. Uses a dry-run of syncDefaults for each project.
   * Returns only projects that have at least one outdated file.
   */
  getStaleDefaults(): StaleDefaults[] {
    const results: StaleDefaults[] = [];
    for (const project of this.getAll()) {
      const outdated = this.syncDefaults(project.path, true);
      if (outdated.length > 0) {
        results.push({
          projectName: project.name,
          projectPath: project.path,
          outdatedFiles: outdated,
        });
      }
    }
    return results;
  }

  /**
   * Copy default roles and commands into the target project
   * if they don't already exist. Never overwrites existing files.
   */
  private scaffold(projectPath: string): void {
    const targets = [
      { src: join(DEFAULTS_DIR, 'roles'), dest: join(projectPath, '.claude', 'roles') },
      { src: join(DEFAULTS_DIR, 'commands'), dest: join(projectPath, '.claude', 'commands') },
    ];

    for (const { src, dest } of targets) {
      mkdirSync(dest, { recursive: true });
      for (const file of readdirSync(src)) {
        const destFile = join(dest, file);
        if (!existsSync(destFile)) {
          cpSync(join(src, file), destFile);
        }
      }
    }

    mkdirSync(join(projectPath, '.teamai'), { recursive: true });

    // Scaffold pipeline.json if not present
    const pipelineDest = join(projectPath, '.teamai', 'pipeline.json');
    if (!existsSync(pipelineDest)) {
      cpSync(join(DEFAULTS_DIR, 'pipeline.json'), pipelineDest);
    }

    // Scaffold providers.json if not present
    const providersDest = join(projectPath, '.teamai', 'providers.json');
    if (!existsSync(providersDest)) {
      cpSync(join(DEFAULTS_DIR, 'providers.json'), providersDest);
    }

    // Copy teamai-workflow.md into .claude/ if not already there
    const workflowDest = join(projectPath, '.claude', 'teamai-workflow.md');
    if (!existsSync(workflowDest)) {
      cpSync(join(DEFAULTS_DIR, 'teamai-workflow.md'), workflowDest);
    }

    // Ensure root CLAUDE.md references the workflow file
    const IMPORT_LINE = '@.claude/teamai-workflow.md';
    const claudeMdPath = join(projectPath, 'CLAUDE.md');
    if (!existsSync(claudeMdPath)) {
      writeFileSync(claudeMdPath, IMPORT_LINE + '\n');
    } else {
      const content = readFileSync(claudeMdPath, 'utf-8');
      if (!content.includes(IMPORT_LINE)) {
        writeFileSync(claudeMdPath, IMPORT_LINE + '\n' + content);
      }
    }

    // Sync defaults that have been updated in TeamAI but not customized by the project
    this.syncDefaults(projectPath);
  }
}

export const projectStore = new ProjectStore();

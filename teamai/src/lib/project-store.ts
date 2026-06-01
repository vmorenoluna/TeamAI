import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, renameSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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
  }
}

export const projectStore = new ProjectStore();

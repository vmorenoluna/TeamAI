import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, renameSync, rmSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

/**
 * Resolve the TeamAI config directory. Precedence:
 * 1. TEAMAI_CONFIG_DIR env var (set by e2e tests to isolate from real config)
 * 2. .teamai-e2e-config-path file (written by Playwright globalSetup so the
 *    dev server child process picks up the temp dir even without the env var)
 * 3. ~/.teamai/ (production)
 */
function resolveConfigDir(): string {
  if (process.env.TEAMAI_CONFIG_DIR) {
    return join(process.env.TEAMAI_CONFIG_DIR, '.teamai');
  }
  try {
    const e2ePathFile = join(process.cwd(), '.teamai-e2e-config-path');
    if (existsSync(e2ePathFile)) {
      const dir = readFileSync(e2ePathFile, 'utf-8').trim();
      if (dir) return join(dir, '.teamai');
    }
  } catch { /* fall through */ }
  return join(homedir(), '.teamai');
}

const CONFIG_DIR = resolveConfigDir();
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

    // Note: we intentionally do NOT auto-create projects.json with [].
    // getAll() already handles a missing file gracefully (returns []).
    // Auto-creating the file causes data loss when existsSync returns a
    // false negative (common on Windows with AV/cloud sync) — the empty
    // write overwrites a valid file that was written moments before.
  }

  getAll(): Project[] {
    try {
      return JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
    } catch {
      return [];
    }
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
    // roles/ are user-configurable from the UI (persona / tone / domain customisation)
    // and must never be auto-synced — only commands/ and top-level files are managed.
    const scanDirs = [
      { src: join(DEFAULTS_DIR, 'commands'), prefix: 'commands' },
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
   * Ensure the project's .gitignore excludes transient TeamAI files that
   * should never be version-controlled (sensitive terminal output, crash-
   * recovery state). Appends entries only if they are not already present.
   */
  private _updateGitignore(projectPath: string): void {
    const gitignorePath = join(projectPath, '.gitignore');
    const TEAMAI_PATTERNS = ['.teamai/*/output.log', '.teamai/*/.pipeline_state.json'];

    const buildBlock = (patterns: string[]) =>
      '# TeamAI — exclude transient pipeline files\n' + patterns.join('\n') + '\n';

    if (!existsSync(gitignorePath)) {
      try {
        writeFileSync(gitignorePath, buildBlock(TEAMAI_PATTERNS));
      } catch { /* best-effort — don't block project setup on .gitignore write failure */ }
      return;
    }

    try {
      const existing = readFileSync(gitignorePath, 'utf-8');
      const lines = existing.split('\n');

      // Only append patterns that are not already present (exact line match).
      const missing = TEAMAI_PATTERNS.filter(
        pattern => !lines.some(line => line.trim() === pattern),
      );
      if (missing.length === 0) return;

      const separator = existing.endsWith('\n') ? '' : '\n';
      appendFileSync(gitignorePath, separator + '\n' + buildBlock(missing));
    } catch { /* best-effort */ }
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
        const destFile = join(projectPath, '.claude', relPath);
        if (!existsSync(destFile)) {
          // Brand-new default file, project never had it — copy it.
          if (!dryRun) {
            const srcFile = join(DEFAULTS_DIR, relPath);
            if (existsSync(srcFile)) cpSync(srcFile, destFile);
          }
          newManifest[relPath] = currentChecksum;
          updated.push(relPath);
        } else {
          // File exists but has no stored baseline (manifest was absent or the
          // file predates the manifest). Compute the project file's checksum
          // and compare to the current default. If they match, the file is
          // genuinely in sync — record the default checksum as the baseline.
          // If they differ, record the project's checksum so future default
          // changes are still trackable, and flag the file as outdated.
          const projectChecksum = this._computeChecksum(readFileSync(destFile, 'utf-8'));

          if (projectChecksum === currentChecksum) {
            newManifest[relPath] = currentChecksum;
          } else {
            newManifest[relPath] = projectChecksum;
            updated.push(relPath);
          }
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
      } catch (err) {
        console.error(`[ProjectStore] Failed to write scaffold manifest at ${manifestPath}:`, err);
      }
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

    // Ensure .gitignore excludes transient/potentially-sensitive TeamAI files
    this._updateGitignore(projectPath);

    // Sync defaults that have been updated in TeamAI but not customized by the project
    this.syncDefaults(projectPath);
  }
}

export const projectStore = new ProjectStore();

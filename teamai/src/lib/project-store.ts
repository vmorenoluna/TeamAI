import { readFileSync, writeFileSync, mkdirSync, existsSync, cpSync, readdirSync, renameSync, rmSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';
import { error as logError, warn as logWarn } from './logger';
import { listCommandNames, readCommandTemplate } from './command-templates';

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
    const e2ePathFile = join(/* turbopackIgnore: true */ process.cwd(), '.teamai-e2e-config-path');
    if (existsSync(e2ePathFile)) {
      const dir = readFileSync(e2ePathFile, 'utf-8').trim();
      if (dir) return join(dir, '.teamai');
    }
  } catch { /* fall through */ }
  return join(homedir(), '.teamai');
}

// Lazy — avoids module-scope filesystem ops that trigger Turbopack NFT tracing.
let _configDir: string | undefined;
function getConfigDir() {
  if (!_configDir) _configDir = resolveConfigDir();
  return _configDir;
}
function getProjectsFile() { return join(getConfigDir(), 'projects.json'); }
function getBackupFile() { return getProjectsFile() + '.backup'; }
function getTmpFile() { return getProjectsFile() + '.tmp'; }
/** Lazy getter — avoids module-scope process.cwd() that triggers Turbopack NFT tracing. */
function getDefaultsDir() {
  return join(/* turbopackIgnore: true */ process.cwd(), 'defaults');
}

export interface Project {
  name: string;
  path: string;
  addedAt: string;
}

/** Result from getStaleDefaults: a project with outdated default files. */
export interface StaleDefaults {
  projectName: string;
  projectPath: string;
  /** Relative paths of defaults that would be force-synced (differ from shipped defaults). */
  outdatedFiles: string[];
}

/** Per-project entry in the startup auto-sync report. */
export interface DefaultsSyncProjectReport {
  projectName: string;
  projectPath: string;
  /** Relative paths of default command files that were overwritten. */
  updatedFiles: string[];
}

/** Report of the startup auto-sync, surfaced as an informational banner in the UI. */
export interface DefaultsSyncReport {
  syncedAt: string;
  projects: DefaultsSyncProjectReport[];
}

export class ProjectStore {
  constructor() {
    mkdirSync(getConfigDir(), { recursive: true });

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
      return JSON.parse(readFileSync(getProjectsFile(), 'utf-8'));
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
    if (existsSync(getProjectsFile())) {
      writeFileSync(getBackupFile(), readFileSync(getProjectsFile(), 'utf-8'));
    }

    // 2. Write to temp file (if we crash here, real file is untouched)
    writeFileSync(getTmpFile(), JSON.stringify(compute(), null, 2));

    // 3. Atomically replace real file with temp
    renameSync(getTmpFile(), getProjectsFile());

    // 4. Clean up backup on success
    try { rmSync(getBackupFile()); } catch { /* best-effort */ }
  }

  /**
   * Check for a leftover backup from a crashed write and restore it.
   * Called once at startup so the user's project registry is never
   * left in a corrupted or partially-modified state.
   */
  private _restoreFromBackup(): void {
    if (!existsSync(getBackupFile())) return;
    try {
      writeFileSync(getProjectsFile(), readFileSync(getBackupFile(), 'utf-8'));
      rmSync(getBackupFile());
    } catch (err) {
      // If restore fails, leave the backup in place for manual recovery — but
      // surface it so a failed restore is diagnosable instead of silent.
      logWarn('project-store', 'Failed to restore projects.json from backup — backup left in place', err);
    }
  }

  // ── Defaults force-sync ──────────────────────────────────────────

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
    // Commands are checksummed as they are written: include-expanded (see
    // command-templates.ts), so `_shared/` fragments are never copied on
    // their own and every project copy is self-contained.
    for (const name of listCommandNames()) {
      manifest[`commands/${name}.md`] = this._computeChecksum(readCommandTemplate(name));
    }
    // teamai-workflow.md is a top-level default, not in commands/ or roles/
    const workflowSrc = join(getDefaultsDir(), 'teamai-workflow.md');
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
    const TEAMAI_PATTERNS = ['.teamai/*'];

    const buildBlock = (patterns: string[]) =>
      '# TeamAI — exclude transient pipeline files\n' + patterns.join('\n') + '\n';

    if (!existsSync(gitignorePath)) {
      try {
        writeFileSync(gitignorePath, buildBlock(TEAMAI_PATTERNS));
      } catch (err) {
        // Don't block project setup, but surface it: a missing .gitignore
        // changes what gets committed into the artifact snapshot.
        logWarn('project-store', `Failed to write .gitignore at ${gitignorePath}`, err);
      }
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
    } catch (err) {
      logWarn('project-store', `Failed to update .gitignore at ${gitignorePath}`, err);
    }
  }

  /**
   * Ensure the project's .gitattributes has a TeamAI-managed line-ending
   * normalization policy so host and container agree on line endings for
   * every tracked file. Appends the block only if not already present —
   * never overwrites the project's own .gitattributes content.
   *
   * @returns true if the TeamAI block was newly added (the project didn't
   *          already have it), false if it was already present or unchanged.
   */
  private _updateGitattributes(projectPath: string): boolean {
    const gitattributesPath = join(projectPath, '.gitattributes');
    const GITATTRIBUTES_BLOCK = [
      '# TeamAI — consistent line-ending normalization across host and container',
      '* text=auto eol=lf',
    ];
    const blockStr = GITATTRIBUTES_BLOCK.join('\n') + '\n';

    if (!existsSync(gitattributesPath)) {
      try {
        writeFileSync(gitattributesPath, blockStr);
        // New file created — flag the renormalize suggestion for the user.
        // Without `git add --renormalize .`, the next auto-commit will be a
        // large normalization commit with no real content change.
        this._writeRenormalizeSuggestion(projectPath);
        return true;
      } catch (err) {
        logWarn('project-store', `Failed to write .gitattributes at ${gitattributesPath}`, err);
      }
      return false;
    }

    try {
      const existing = readFileSync(gitattributesPath, 'utf-8');
      const lines = existing.split('\n');

      // Only append patterns that are not already present (exact line match).
      const missing = GITATTRIBUTES_BLOCK.filter(
        pattern => !lines.some(line => line.trim() === pattern),
      );
      if (missing.length === 0) return false;

      const separator = existing.endsWith('\n') ? '' : '\n';
      appendFileSync(gitattributesPath, separator + '\n' + missing.join('\n') + '\n');
      this._writeRenormalizeSuggestion(projectPath);
      return true;
    } catch (err) {
      logWarn('project-store', `Failed to update .gitattributes at ${gitattributesPath}`, err);
    }
    return false;
  }

  /** Write a marker file so the UI can suggest `git add --renormalize .`. */
  private _writeRenormalizeSuggestion(projectPath: string): void {
    try {
      const teamaiDir = join(projectPath, '.teamai');
      mkdirSync(teamaiDir, { recursive: true });
      writeFileSync(join(teamaiDir, 'gitattributes-renormalize-suggestion'), '');
    } catch (err) {
      logWarn('project-store', `Failed to write renormalize suggestion for ${projectPath}`, err);
    }
  }

  /**
   * Force-sync default command files (and teamai-workflow.md) into the
   * project's .claude/ directory.
   *
   * Commands are TeamAI's orchestration contract. The orchestrator renders
   * pipeline sessions' instructions from TeamAI's own defaults (see
   * command-templates.ts), so these project copies serve sessions that invoke
   * a command themselves (the root checkout's ideation/roadmap/refinement
   * sessions, or a user typing one) and must match the shipped defaults.
   * Unlike roles (the user-owned persona surface, never auto-synced), commands are overwritten unconditionally so a
   * customized command can never drift the workflow away from what the
   * orchestrator expects. Overwrite detection compares each live project
   * file's content against the shipped defaults' checksums directly — no
   * per-project manifest is persisted.
   *
   * When `dryRun` is true, computes what WOULD be overwritten without
   * writing any files. Returns the relative paths of files that were (or
   * would be) updated.
   */
  syncDefaults(projectPath: string, dryRun = false): string[] {
    const updated: string[] = [];
    const currentManifest = this._getDefaultsManifest();

    for (const [relPath, currentChecksum] of Object.entries(currentManifest)) {
      const srcFile = join(getDefaultsDir(), relPath);
      if (!existsSync(srcFile)) continue;

      const destFile = join(projectPath, '.claude', relPath);
      const matches = existsSync(destFile) &&
        this._computeChecksum(readFileSync(destFile, 'utf-8')) === currentChecksum;

      if (!matches) {
        if (!dryRun) {
          mkdirSync(dirname(destFile), { recursive: true });
          writeFileSync(destFile, this._renderDefault(relPath));
        }
        updated.push(relPath);
      }
    }

    return updated;
  }

  /** Content a synced default is written with: commands include-expanded,
   *  everything else verbatim. */
  private _renderDefault(relPath: string): string {
    const command = /^commands\/([^/]+)\.md$/.exec(relPath);
    if (command) return readCommandTemplate(command[1]);
    return readFileSync(join(getDefaultsDir(), relPath), 'utf-8');
  }

  /** Path of the persisted auto-sync report read by the UI banner. */
  private _syncReportPath(): string {
    return join(getConfigDir(), 'defaults-sync-report.json');
  }

  /**
   * Force-sync default commands into every registered project and persist a
   * report of what changed so the UI can surface it as an informational
   * banner (instead of a click-to-sync prompt). Called once at startup,
   * before any session can run.
   */
  syncAllProjectsDefaults(): DefaultsSyncReport {
    const report: DefaultsSyncReport = {
      syncedAt: new Date().toISOString(),
      projects: [],
    };

    for (const project of this.getAll()) {
      let updated: string[] = [];
      try {
        updated = this.syncDefaults(project.path);
      } catch (err) {
        logError('ProjectStore', `Failed to sync defaults for ${project.path}`, err);
        continue;
      }
      if (updated.length > 0) {
        report.projects.push({
          projectName: project.name,
          projectPath: project.path,
          updatedFiles: updated,
        });
      }
    }

    // Always (re)write the report so a stale report from a previous startup
    // can't resurrect a banner that no longer applies.
    try {
      writeFileSync(this._syncReportPath(), JSON.stringify(report, null, 2));
    } catch (err) {
      logError('ProjectStore', 'Failed to write defaults sync report', err);
    }

    return report;
  }

  /**
   * Read the persisted auto-sync report, or null when no project changed
   * (or no report exists).
   */
  getDefaultsSyncReport(): DefaultsSyncReport | null {
    try {
      const parsed = JSON.parse(
        readFileSync(this._syncReportPath(), 'utf-8'),
      ) as DefaultsSyncReport;
      if (!parsed || !Array.isArray(parsed.projects) || parsed.projects.length === 0) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /** Dismiss the auto-sync banner by removing the persisted report. */
  dismissDefaultsSyncReport(): void {
    try {
      if (existsSync(this._syncReportPath())) rmSync(this._syncReportPath());
    } catch (err) {
      logError('ProjectStore', 'Failed to dismiss defaults sync report', err);
    }
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
    const rolesSrc = join(getDefaultsDir(), 'roles');
    const rolesDest = join(projectPath, '.claude', 'roles');
    mkdirSync(rolesDest, { recursive: true });
    for (const file of readdirSync(rolesSrc)) {
      const destFile = join(rolesDest, file);
      if (!existsSync(destFile)) {
        cpSync(join(rolesSrc, file), destFile);
      }
    }

    const commandsDest = join(projectPath, '.claude', 'commands');
    mkdirSync(commandsDest, { recursive: true });
    for (const name of listCommandNames()) {
      const destFile = join(commandsDest, `${name}.md`);
      if (!existsSync(destFile)) {
        writeFileSync(destFile, readCommandTemplate(name));
      }
    }

    mkdirSync(join(projectPath, '.teamai'), { recursive: true });

    // Scaffold pipeline.json if not present
    const pipelineDest = join(projectPath, '.teamai', 'pipeline.json');
    if (!existsSync(pipelineDest)) {
      cpSync(join(getDefaultsDir(), 'pipeline.json'), pipelineDest);
    }

    // Scaffold providers.json if not present
    const providersDest = join(projectPath, '.teamai', 'providers.json');
    if (!existsSync(providersDest)) {
      cpSync(join(getDefaultsDir(), 'providers.json'), providersDest);
    }

    // Copy teamai-workflow.md into .claude/ if not already there
    const workflowDest = join(projectPath, '.claude', 'teamai-workflow.md');
    if (!existsSync(workflowDest)) {
      cpSync(join(getDefaultsDir(), 'teamai-workflow.md'), workflowDest);
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

    // Ensure .gitattributes has consistent line-ending normalization across host and container
    this._updateGitattributes(projectPath);

    // Force-sync the latest default commands (overwrites any customization).
    this.syncDefaults(projectPath);
  }
}

// Lazy singleton — defers ProjectStore construction (which does mkdirSync +
// _restoreFromBackup) until first use, avoiding module-scope filesystem ops
// that trigger Turbopack NFT tracing warnings during build.
let _projectStore: ProjectStore | undefined;
function getProjectStore(): ProjectStore {
  if (!_projectStore) _projectStore = new ProjectStore();
  return _projectStore;
}
export const projectStore: ProjectStore = new Proxy({} as ProjectStore, {
  get(_target, prop, _receiver) {
    const store = getProjectStore();
    const value = (store as unknown as Record<string | symbol, unknown>)[prop];
    if (typeof value === 'function') {
      return (...args: unknown[]) => (value as (...a: unknown[]) => unknown).apply(store, args);
    }
    return value;
  },
});

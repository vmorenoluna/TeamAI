import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ProjectStore } from '@/lib/project-store';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { registerTestProject } from '../utils/test-project';

// ProjectStore is a singleton that writes to ~/.teamai/projects.json.
// Each test must use a unique project path and clean up after itself.

describe('ProjectStore', () => {
  let store: ProjectStore;
  let projectDir: string;
  let clean: () => void;

  beforeEach(() => {
    const testProject = registerTestProject();
    projectDir = testProject.root;
    store = testProject.store;
    clean = testProject.clean;
  });

  afterEach(() => {
    clean();
  });

  it('getAll returns an array', () => {
    const projects = store.getAll();
    expect(Array.isArray(projects)).toBe(true);
  });

  it('getByPath returns null for unknown path', () => {
    const result = store.getByPath('/nonexistent/path/xyz-' + randomUUID());
    expect(result).toBeNull();
  });

  it('add registers a new project and scaffolds files', () => {
    const project = store.add(projectDir, 'Test Project');

    expect(project.name).toBe('Test Project');
    expect(project.path).toBe(projectDir);
    expect(project.addedAt).toBeDefined();

    // Should have scaffolded .claude/roles/ directory
    expect(existsSync(join(projectDir, '.claude', 'roles'))).toBe(true);
    expect(existsSync(join(projectDir, '.claude', 'commands'))).toBe(true);
    expect(existsSync(join(projectDir, '.teamai'))).toBe(true);
    expect(existsSync(join(projectDir, '.teamai', 'pipeline.json'))).toBe(true);
    expect(existsSync(join(projectDir, '.teamai', 'providers.json'))).toBe(true);

    // CLAUDE.md should reference the workflow
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(true);
    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('@.claude/teamai-workflow.md');
  });

  it('add throws when registering the same project twice', () => {
    store.add(projectDir, 'Test Project');

    expect(() => store.add(projectDir, 'Duplicate')).toThrow('already_registered');
  });

  it('getByPath returns project after add', () => {
    store.add(projectDir, 'Test Project');

    const found = store.getByPath(projectDir);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Test Project');
  });

  it('remove removes project from store', () => {
    store.add(projectDir, 'Test Project');
    expect(store.getByPath(projectDir)).not.toBeNull();

    store.remove(projectDir);

    expect(store.getByPath(projectDir)).toBeNull();
  });

  it('remove is idempotent — removing non-existent project does not throw', () => {
    expect(() => store.remove('/nonexistent/path/xyz-' + randomUUID())).not.toThrow();
  });

  it('scaffold does not overwrite existing files', () => {
    // First add creates all files
    store.add(projectDir, 'Test Project');

    // Remove from store but keep files
    store.remove(projectDir);

    // Write a custom CLAUDE.md
    const customContent = '# Custom CLAUDE.md\n@.claude/teamai-workflow.md\nExtra content';
    writeFileSync(join(projectDir, 'CLAUDE.md'), customContent);

    // Re-add — scaffold should preserve existing CLAUDE.md
    store.add(projectDir, 'Test Project 2');
    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toBe(customContent);
  });

  it('getName generates name from path when name not provided', () => {
    const project = store.add(projectDir);

    // Name is derived from last segment of path
    expect(project.name).toBe(projectDir.split(/[\\\\/]/).pop()!);
    expect(project.path).toBe(projectDir);
  });

  // ── Coverage: line 45 — || projectPath fallback when split().pop() returns '' ──

  it('falls back to full path when last segment is empty (path ends in separator)', () => {
    // Using store.add directly with path ending in \ so split().pop() returns ''
    const trailingPath = projectDir.replace(/[\\/]+$/, '') + '\\';
    const project = store.add(trailingPath);

    // name not provided → projectPath.split().pop() returns '' → '' is falsy → full path
    expect(project.name).toBe(trailingPath);
    expect(project.path).toBe(trailingPath);

    // Cleanup: remove the trailing-path entry
    store.remove(trailingPath);
  });

  // ── Coverage: lines 20-21 — initial empty projects.json ──

  it('scaffold prepends IMPORT_LINE to existing CLAUDE.md without it', () => {
    // First add creates default CLAUDE.md
    store.add(projectDir, 'Test Project');
    store.remove(projectDir);

    // Replace CLAUDE.md with content that does NOT include the IMPORT_LINE
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# My custom content\n\nSome docs here.');
    // Verify it doesn't have the import line yet
    const before = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(before).not.toContain('@.claude/teamai-workflow.md');

    // Re-add — scaffold should prepend IMPORT_LINE
    store.add(projectDir, 'Test Project 2');

    const after = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after).toContain('@.claude/teamai-workflow.md');
    expect(after).toContain('# My custom content');
    // IMPORT_LINE should come first
    expect(after.indexOf('@.claude/teamai-workflow.md')).toBeLessThan(after.indexOf('# My custom content'));
  });

  // ── Coverage: lines 109-110 ──

  it('scaffold creates CLAUDE.md with IMPORT_LINE when file does not exist', () => {
    store.add(projectDir, 'Test Project');
    store.remove(projectDir);

    // Delete the CLAUDE.md entirely
    unlinkSync(join(projectDir, 'CLAUDE.md'));
    expect(existsSync(join(projectDir, 'CLAUDE.md'))).toBe(false);

    // Re-add — scaffold should create CLAUDE.md
    store.add(projectDir, 'Test Project 2');

    const claudeMd = readFileSync(join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(claudeMd).toContain('@.claude/teamai-workflow.md');
  });

  // ── Coverage: lines 20-21 — constructor init when projects.json missing ──

  it('initializes projects.json when it does not exist on construction', () => {
    const projectsFile = join(homedir(), '.teamai', 'projects.json');

    // Backup current file, delete, create new store, verify init, restore
    const backup = existsSync(projectsFile) ? readFileSync(projectsFile, 'utf-8') : null;
    if (existsSync(projectsFile)) {
      rmSync(projectsFile);
    }

    try {
      const freshStore = new ProjectStore();
      expect(freshStore.getAll()).toEqual([]);
    } finally {
      // Restore the backup so subsequent tests are unaffected
      if (backup !== null) {
        writeFileSync(projectsFile, backup);
      }
    }
  });
});

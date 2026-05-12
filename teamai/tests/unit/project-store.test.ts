import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ProjectStore } from '@/lib/project-store';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ProjectStore is a singleton that writes to ~/.teamai/projects.json.
// Each test must use a unique project path and clean up after itself.

describe('ProjectStore', () => {
  let store: ProjectStore;
  let projectDir: string;

  beforeEach(() => {
    projectDir = join(process.cwd(), '.teamai-test-project-' + randomUUID().slice(0, 8));
    mkdirSync(projectDir, { recursive: true });
    store = new ProjectStore();
  });

  afterEach(() => {
    // Clean up from the store (remove registration)
    try { store.remove(projectDir); } catch { /* may not be registered */ }
    // Clean up the temp directory
    if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
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
    expect(project.name).toBe(projectDir.split(/[\\/]/).pop()!);
    expect(project.path).toBe(projectDir);
  });
});

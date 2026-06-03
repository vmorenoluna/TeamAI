import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { ProjectStore } from '@/lib/project-store';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync, cpSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── Mock homedir to a temp directory so tests NEVER touch the real ~/.teamai ──
// vi.hoisted() runs before vi.mock factories, so TEST_HOME is initialized first.
const TEST_HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require('path');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('crypto');
  return path.join(process.cwd(), '.teamai-test-home-' + crypto.randomUUID().slice(0, 8));
});
vi.mock('os', () => ({
  homedir: () => TEST_HOME,
}));

describe('ProjectStore', () => {
  let store: ProjectStore;
  let projectDir: string;
  let clean: () => void;

  // Cleanup the mock home directory after ALL tests
  afterAll(() => {
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    projectDir = join(process.cwd(), '.teamai-test-' + randomUUID().slice(0, 8));
    mkdirSync(projectDir, { recursive: true });
    store = new ProjectStore();
    clean = () => {
      if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });
    };
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
    const projectsFile = join(TEST_HOME, '.teamai', 'projects.json');

    // Delete the mock file to simulate first-time setup
    if (existsSync(projectsFile)) {
      rmSync(projectsFile);
    }

    const freshStore = new ProjectStore();
    expect(freshStore.getAll()).toEqual([]);
  });

  // ── Defaults version tracking ───────────────────────────────────

  it('scaffold writes .teamai-scaffold.json manifest after copying defaults', () => {
    store.add(projectDir, 'Test Project');

    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    expect(existsSync(manifestPath)).toBe(true);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(manifest.version).toBe(1);
    expect(manifest.files).toBeDefined();
    // Should have entries for commands, roles, and workflow
    expect(manifest.files['commands/implement.md']).toBeDefined();
    expect(manifest.files['roles/coder.md']).toBeDefined();
    expect(manifest.files['teamai-workflow.md']).toBeDefined();
    // Checksums should be sha256:...
    for (const checksum of Object.values(manifest.files) as string[]) {
      expect(checksum).toMatch(/^sha256:[a-f0-9]{16}$/);
    }
  });

  it('syncDefaults detects a changed default and updates an uncustomized project file', () => {
    store.add(projectDir, 'Test Project');

    // Simulate a default update: modify the project's implement.md to match
    // what would happen if a newer TeamAI version shipped a different file.
    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalContent = readFileSync(implPath, 'utf-8');

    // First, read the manifest to get the stored checksum
    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    const storedChecksum = manifest.files['commands/implement.md'];

    // Verify the project file matches the stored checksum (uncustomized)
    const projectChecksum = 'sha256:' + createHash('sha256').update(originalContent).digest('hex').slice(0, 16);
    expect(projectChecksum).toBe(storedChecksum);

    // Modify the default source to simulate a TeamAI update
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    const modifiedDefault = defaultBackup + '\n\n<!-- Updated in TeamAI v2.0 -->\n';
    writeFileSync(defaultImplSrc, modifiedDefault);

    try {
      // Re-add the project — scaffold should call syncDefaults and update the file
      store.remove(projectDir);
      store.add(projectDir, 'Test Project');

      // The project file should now match the new default
      const updatedContent = readFileSync(implPath, 'utf-8');
      expect(updatedContent).toBe(modifiedDefault);
      expect(updatedContent).toContain('Updated in TeamAI v2.0');

      // The manifest should have the new checksum
      const newManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      expect(newManifest.files['commands/implement.md']).not.toBe(storedChecksum);
    } finally {
      // Restore the default file
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

  it('syncDefaults does NOT overwrite a customized project file', () => {
    store.add(projectDir, 'Test Project');

    // Customize the implement.md in the project
    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalContent = readFileSync(implPath, 'utf-8');
    const customized = originalContent + '\n\n# My custom additions\nCustom rule here.\n';
    writeFileSync(implPath, customized);

    // Modify the default source to simulate a TeamAI update
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    const modifiedDefault = defaultBackup + '\n\n<!-- Updated in TeamAI v2.0 -->\n';
    writeFileSync(defaultImplSrc, modifiedDefault);

    try {
      // Re-add — syncDefaults should detect the customization and skip the update
      store.remove(projectDir);
      store.add(projectDir, 'Test Project');

      // The project file should STILL be the customized version
      const currentContent = readFileSync(implPath, 'utf-8');
      expect(currentContent).toBe(customized);
      expect(currentContent).toContain('My custom additions');
      // Should NOT contain the default update
      expect(currentContent).not.toContain('Updated in TeamAI v2.0');
    } finally {
      // Restore the default file
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

  it('syncDefaults returns the list of files that were updated', () => {
    store.add(projectDir, 'Test Project');

    // Modify the default source
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, defaultBackup + '\n\n<!-- v2 -->\n');

    try {
      store.remove(projectDir);

      // Call syncDefaults directly and check return value
      const updated = store.syncDefaults(projectDir);

      // The uncustomized implement.md should be in the list
      expect(updated).toContain('commands/implement.md');
      // Other files that didn't change should NOT be in the list
      expect(updated).not.toContain('roles/coder.md');
    } finally {
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

  it('syncDefaults handles projects without a manifest (older TeamAI projects)', () => {
    // Manually create project dirs without calling scaffold
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });
    mkdirSync(join(projectDir, '.claude', 'roles'), { recursive: true });

    // Copy a default that exists but leave out another
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    cpSync(defaultImplSrc, join(projectDir, '.claude', 'commands', 'implement.md'));

    // No manifest exists
    expect(existsSync(join(projectDir, '.claude', '.teamai-scaffold.json'))).toBe(false);

    // syncDefaults should create the manifest and not crash
    const updated = store.syncDefaults(projectDir);

    // Should have created the manifest
    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    expect(existsSync(manifestPath)).toBe(true);

    // Should have copied missing defaults that project doesn't have
    expect(existsSync(join(projectDir, '.claude', 'roles', 'coder.md'))).toBe(true);

    // The already-existing implement.md should NOT be overwritten
    const implContent = readFileSync(join(projectDir, '.claude', 'commands', 'implement.md'), 'utf-8');
    const defaultContent = readFileSync(defaultImplSrc, 'utf-8');
    expect(implContent).toBe(defaultContent);
  });
  // ── syncDefaults dryRun edge cases ───────────────────────────────

  it('syncDefaults dryRun does not write any files or manifest', () => {
    store.add(projectDir, 'Test Project');

    // Simulate a TeamAI update by modifying the default source
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, defaultBackup + '\n\n<!-- dryRun test -->\n');

    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalContent = readFileSync(implPath, 'utf-8');
    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    const manifestBefore = readFileSync(manifestPath, 'utf-8');

    try {
      const updated = store.syncDefaults(projectDir, true);

      // dryRun should report what WOULD be updated
      expect(updated).toContain('commands/implement.md');

      // But the file should NOT have been changed
      const currentContent = readFileSync(implPath, 'utf-8');
      expect(currentContent).toBe(originalContent);

      // And the manifest should NOT have been rewritten
      const manifestAfter = readFileSync(manifestPath, 'utf-8');
      expect(manifestAfter).toBe(manifestBefore);
    } finally {
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

  it('syncDefaults handles a deleted project file by restoring from defaults', () => {
    store.add(projectDir, 'Test Project');

    const rolePath = join(projectDir, '.claude', 'roles', 'coder.md');
    expect(existsSync(rolePath)).toBe(true);

    // Delete the role file from the project
    unlinkSync(rolePath);
    expect(existsSync(rolePath)).toBe(false);

    // Modify the default source to trigger a checksum mismatch — the deleted-file
    // check only runs when storedChecksum !== currentChecksum.
    const defaultRoleSrc = join(process.cwd(), 'defaults', 'roles', 'coder.md');
    const defaultRoleBackup = readFileSync(defaultRoleSrc, 'utf-8');
    writeFileSync(defaultRoleSrc, defaultRoleBackup + '\n\n<!-- restore-deleted test -->\n');

    try {
      // syncDefaults should detect the changed default, find the missing file, and restore it
      const updated = store.syncDefaults(projectDir);
      expect(updated).toContain('roles/coder.md');

      // The file should be restored with the NEW default content
      expect(existsSync(rolePath)).toBe(true);
      const restoredContent = readFileSync(rolePath, 'utf-8');
      expect(restoredContent).toBe(defaultRoleBackup + '\n\n<!-- restore-deleted test -->\n');
    } finally {
      writeFileSync(defaultRoleSrc, defaultRoleBackup);
    }
  });

  it('syncDefaults dryRun reports a deleted file without restoring it', () => {
    store.add(projectDir, 'Test Project');

    const rolePath = join(projectDir, '.claude', 'roles', 'qa-reviewer.md');
    expect(existsSync(rolePath)).toBe(true);

    // Delete the role file
    unlinkSync(rolePath);
    expect(existsSync(rolePath)).toBe(false);

    // Modify the default source to trigger a checksum mismatch
    const defaultRoleSrc = join(process.cwd(), 'defaults', 'roles', 'qa-reviewer.md');
    const defaultRoleBackup = readFileSync(defaultRoleSrc, 'utf-8');
    writeFileSync(defaultRoleSrc, defaultRoleBackup + '\n\n<!-- dryRun-deleted test -->\n');

    try {
      // dryRun should report it but not restore
      const updated = store.syncDefaults(projectDir, true);
      expect(updated).toContain('roles/qa-reviewer.md');
      expect(existsSync(rolePath)).toBe(false);
    } finally {
      writeFileSync(defaultRoleSrc, defaultRoleBackup);
    }
  });

  it('syncDefaults handles malformed manifest JSON gracefully', () => {
    store.add(projectDir, 'Test Project');

    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalImpl = readFileSync(implPath, 'utf-8');

    // Corrupt the manifest
    writeFileSync(manifestPath, '{ not valid json }');

    // Delete one file so we can verify that missing files ARE copied even
    // when the manifest is malformed (treated as empty).
    const rolePath = join(projectDir, '.claude', 'roles', 'qa-reviewer.md');
    unlinkSync(rolePath);
    expect(existsSync(rolePath)).toBe(false);

    // Should not throw — treats malformed as empty manifest
    const updated = store.syncDefaults(projectDir);

    // Files that were deleted should be restored (reported in updated)
    expect(updated).toContain('roles/qa-reviewer.md');
    expect(existsSync(rolePath)).toBe(true);

    // Existing files should NOT be in updated and NOT be overwritten
    expect(updated).not.toContain('commands/implement.md');
    expect(readFileSync(implPath, 'utf-8')).toBe(originalImpl);

    // Manifest should have been rewritten with correct JSON
    const newManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(newManifest.version).toBe(1);
    expect(newManifest.files).toBeDefined();
    // All defaults should now have checksum entries
    expect(newManifest.files['commands/implement.md']).toMatch(/^sha256:[a-f0-9]{16}$/);
  });

  it('syncDefaults copies a brand-new default file not yet in the project', () => {
    store.add(projectDir, 'Test Project');

    // Create a temporary new default file that doesn't exist in the project
    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-new-command.md');
    writeFileSync(newDefaultPath, '# New test command\n\nThis is a new default.\n');

    const destPath = join(projectDir, '.claude', 'commands', '.test-new-command.md');
    expect(existsSync(destPath)).toBe(false);

    try {
      // syncDefaults should copy the new default to the project
      const updated = store.syncDefaults(projectDir);
      expect(updated).toContain('commands/.test-new-command.md');

      // File should now exist
      expect(existsSync(destPath)).toBe(true);
      expect(readFileSync(destPath, 'utf-8')).toBe('# New test command\n\nThis is a new default.\n');
    } finally {
      // Cleanup: remove the temp default file
      if (existsSync(newDefaultPath)) unlinkSync(newDefaultPath);
      // Also remove it from the project so future runs don't complain
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  it('syncDefaults does not overwrite an existing project file when a new default is added', () => {
    store.add(projectDir, 'Test Project');

    // Create a temp default file
    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-new-command-2.md');
    writeFileSync(newDefaultPath, '# New default version\n');

    // Also create the same file in the project with different content (simulating
    // a project that already has this file from an older version)
    const destPath = join(projectDir, '.claude', 'commands', '.test-new-command-2.md');
    writeFileSync(destPath, '# Project custom version\n');

    try {
      const updated = store.syncDefaults(projectDir);
      // The file already exists, so it should NOT be in the updated list
      expect(updated).not.toContain('commands/.test-new-command-2.md');

      // The project file should be preserved
      expect(readFileSync(destPath, 'utf-8')).toBe('# Project custom version\n');
    } finally {
      if (existsSync(newDefaultPath)) unlinkSync(newDefaultPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  // ── getStaleDefaults edge cases ──────────────────────────────────

  it('getStaleDefaults returns empty when no projects have outdated defaults', () => {
    // Clear all previously-registered projects for isolation
    for (const p of store.getAll()) store.remove(p.path);
    store.add(projectDir, 'Test Project');

    // Freshly added — everything is up to date
    const stale = store.getStaleDefaults();
    expect(stale).toEqual([]);
  });

  it('getStaleDefaults returns projects with outdated files after a default changes', () => {
    // Clear all previously-registered projects for isolation
    for (const p of store.getAll()) store.remove(p.path);
    store.add(projectDir, 'Test Project');

    // Simulate a TeamAI update
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, defaultBackup + '\n\n<!-- getStaleDefaults test -->\n');

    try {
      const stale = store.getStaleDefaults();
      expect(stale.length).toBe(1);
      expect(stale[0].projectName).toBe('Test Project');
      expect(stale[0].projectPath).toBe(projectDir);
      expect(stale[0].outdatedFiles).toContain('commands/implement.md');
    } finally {
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

  it('getStaleDefaults skips projects that are up to date and only returns stale ones', () => {
    // Clear all previously-registered projects for isolation
    for (const p of store.getAll()) store.remove(p.path);
    // Add two projects
    store.add(projectDir, 'Project A');

    const projectB = join(process.cwd(), '.teamai-test-b-' + randomUUID().slice(0, 8));
    mkdirSync(projectB, { recursive: true });
    store.add(projectB, 'Project B');

    // Only modify one project's file to simulate customization
    const implB = join(projectB, '.claude', 'commands', 'implement.md');
    const originalB = readFileSync(implB, 'utf-8');
    writeFileSync(implB, originalB + '\n\n# Customized by Project B\n');

    // Now change the default
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, defaultBackup + '\n\n<!-- partial stale test -->\n');

    try {
      const stale = store.getStaleDefaults();

      // Project A is uncustomized — should be stale
      expect(stale.some(s => s.projectPath === projectDir)).toBe(true);

      // Project B is customized — should NOT be stale (preserved)
      expect(stale.some(s => s.projectPath === projectB)).toBe(false);
    } finally {
      writeFileSync(defaultImplSrc, defaultBackup);
      store.remove(projectB);
      if (existsSync(projectB)) rmSync(projectB, { recursive: true, force: true });
    }
  });

  it('getStaleDefaults does not modify files (uses dryRun internally)', () => {
    // Clear all previously-registered projects for isolation
    for (const p of store.getAll()) store.remove(p.path);
    store.add(projectDir, 'Test Project');

    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalContent = readFileSync(implPath, 'utf-8');

    // Modify the default
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    const defaultBackup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, defaultBackup + '\n\n<!-- dryRun-getStaleDefaults -->\n');

    try {
      const stale = store.getStaleDefaults();
      expect(stale.length).toBe(1);

      // The project file should NOT have been modified
      const currentContent = readFileSync(implPath, 'utf-8');
      expect(currentContent).toBe(originalContent);
    } finally {
      writeFileSync(defaultImplSrc, defaultBackup);
    }
  });

});

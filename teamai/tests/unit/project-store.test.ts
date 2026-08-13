import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { ProjectStore } from '@/lib/project-store';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync, mkdirSync, cpSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { randomUUID } from 'crypto';

// ── Windows file-lock retry helper ──────────────────────────────────────────
// On Windows, writeFileSync / renameSync can fail with EPERM or EBUSY when
// another test file (running in parallel) has the same file open. Retry with
// exponential backoff up to 5 attempts to absorb those transient lock windows.

function retryOnLock(fn: () => void, maxRetries = 5, baseDelay = 50): void {
  for (let i = 0; i < maxRetries; i++) {
    try {
      fn();
      return;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (i === maxRetries - 1 || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw e;
      // Busy-wait (synchronous Node.js has no sleep primitive); max total
      // delay across all retries is ~1.5 s, acceptable for a test helper.
      const start = Date.now();
      while (Date.now() - start < baseDelay * Math.pow(2, i)) { /* spin */ }
    }
  }
}

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
    // Should have entries for commands and workflow — roles are user-customisable and excluded
    expect(manifest.files['commands/implement.md']).toBeDefined();
    expect(manifest.files['teamai-workflow.md']).toBeDefined();
    expect(manifest.files['roles/coder.md']).toBeUndefined();
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
    }
  });

  it('syncDefaults handles projects without a manifest (older TeamAI projects)', () => {
    // Manually create project dirs without calling scaffold
    mkdirSync(join(projectDir, '.claude', 'commands'), { recursive: true });

    // Copy one command default but leave another missing
    const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
    cpSync(defaultImplSrc, join(projectDir, '.claude', 'commands', 'implement.md'));

    // No manifest exists
    expect(existsSync(join(projectDir, '.claude', '.teamai-scaffold.json'))).toBe(false);

    // syncDefaults should create the manifest and not crash
    store.syncDefaults(projectDir);

    // Should have created the manifest
    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    expect(existsSync(manifestPath)).toBe(true);

    // Missing commands should be copied (merge.md was not manually placed)
    expect(existsSync(join(projectDir, '.claude', 'commands', 'merge.md'))).toBe(true);

    // The already-existing implement.md should NOT be overwritten (no baseline — preserved)
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
    }
  });

  it('syncDefaults handles a deleted project command file by restoring from defaults', () => {
    store.add(projectDir, 'Test Project');

    const cmdPath = join(projectDir, '.claude', 'commands', 'merge.md');
    expect(existsSync(cmdPath)).toBe(true);

    // Delete the command file from the project
    unlinkSync(cmdPath);
    expect(existsSync(cmdPath)).toBe(false);

    // Modify the default source to trigger a checksum mismatch — the deleted-file
    // check only runs when storedChecksum !== currentChecksum.
    const defaultCmdSrc = join(process.cwd(), 'defaults', 'commands', 'merge.md');
    const defaultCmdBackup = readFileSync(defaultCmdSrc, 'utf-8');
    writeFileSync(defaultCmdSrc, defaultCmdBackup + '\n\n<!-- restore-deleted test -->\n');

    try {
      // syncDefaults should detect the changed default, find the missing file, and restore it
      const updated = store.syncDefaults(projectDir);
      expect(updated).toContain('commands/merge.md');

      // The file should be restored with the NEW default content
      expect(existsSync(cmdPath)).toBe(true);
      const restoredContent = readFileSync(cmdPath, 'utf-8');
      expect(restoredContent).toBe(defaultCmdBackup + '\n\n<!-- restore-deleted test -->\n');
    } finally {
      retryOnLock(() => writeFileSync(defaultCmdSrc, defaultCmdBackup));
    }
  });

  it('syncDefaults dryRun reports a deleted command file without restoring it', () => {
    store.add(projectDir, 'Test Project');

    const cmdPath = join(projectDir, '.claude', 'commands', 'merge.md');
    expect(existsSync(cmdPath)).toBe(true);

    // Delete the command file
    unlinkSync(cmdPath);
    expect(existsSync(cmdPath)).toBe(false);

    // Modify the default source to trigger a checksum mismatch
    const defaultCmdSrc = join(process.cwd(), 'defaults', 'commands', 'merge.md');
    const defaultCmdBackup = readFileSync(defaultCmdSrc, 'utf-8');
    writeFileSync(defaultCmdSrc, defaultCmdBackup + '\n\n<!-- dryRun-deleted test -->\n');

    try {
      // dryRun should report it but not restore
      const updated = store.syncDefaults(projectDir, true);
      expect(updated).toContain('commands/merge.md');
      expect(existsSync(cmdPath)).toBe(false);
    } finally {
      retryOnLock(() => writeFileSync(defaultCmdSrc, defaultCmdBackup));
    }
  });

  it('syncDefaults handles malformed manifest JSON gracefully', () => {
    store.add(projectDir, 'Test Project');

    const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
    const implPath = join(projectDir, '.claude', 'commands', 'implement.md');
    const originalImpl = readFileSync(implPath, 'utf-8');

    // Corrupt the manifest
    writeFileSync(manifestPath, '{ not valid json }');

    // Delete one command file so we can verify missing files ARE copied even
    // when the manifest is malformed (treated as empty).
    const cmdPath = join(projectDir, '.claude', 'commands', 'merge.md');
    unlinkSync(cmdPath);
    expect(existsSync(cmdPath)).toBe(false);

    // Should not throw — treats malformed as empty manifest
    const updated = store.syncDefaults(projectDir);

    // Missing command files should be copied (reported in updated)
    expect(updated).toContain('commands/merge.md');
    expect(existsSync(cmdPath)).toBe(true);

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

  it('syncDefaults does not overwrite an existing project file when no baseline exists', () => {
    store.add(projectDir, 'Test Project');

    // Create a temp default file
    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-new-command-2.md');
    writeFileSync(newDefaultPath, '# New default version\n');

    // Project already has the same file with different content and NO stored
    // baseline — we cannot tell if it was customised, so we preserve it and
    // record the current default checksum as the baseline for future tracking.
    const destPath = join(projectDir, '.claude', 'commands', '.test-new-command-2.md');
    writeFileSync(destPath, '# Pre-existing project version\n');

    try {
      const updated = store.syncDefaults(projectDir);
      // Cannot auto-update without a baseline — but we DO flag it as outdated
      expect(updated).toContain('commands/.test-new-command-2.md');

      // And record the project's checksum to the manifest (not the default's)
      const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const projectChecksum = 'sha256:' + createHash('sha256').update('# Pre-existing project version\n').digest('hex').slice(0, 16);
      expect(manifest.files['commands/.test-new-command-2.md']).toBe(projectChecksum);

      // Project file is preserved
      expect(readFileSync(destPath, 'utf-8')).toBe('# Pre-existing project version\n');
    } finally {
      if (existsSync(newDefaultPath)) unlinkSync(newDefaultPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  it('syncDefaults flags pre-existing mismatched file as outdated without manifest baseline', () => {
    store.add(projectDir, 'Test Project');

    // Create a new default file
    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-outdated.md');
    writeFileSync(newDefaultPath, '# New default\n');

    // Create a pre-existing project file that differs from the default
    const destPath = join(projectDir, '.claude', 'commands', '.test-outdated.md');
    writeFileSync(destPath, '# Outdated project content\n');

    try {
      // First syncDefaults call should flag it as outdated
      const updated = store.syncDefaults(projectDir);
      expect(updated).toContain('commands/.test-outdated.md');

      // But NOT overwrite the pre-existing project file
      expect(readFileSync(destPath, 'utf-8')).toBe('# Outdated project content\n');
    } finally {
      if (existsSync(newDefaultPath)) unlinkSync(newDefaultPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  it('syncDefaults updates a bootstrapped outdated file on the next run after default changes', () => {
    // Simulate the full lifecycle: bootstrap flags a divergent file →
    // default changes → second run picks it up and updates.
    store.add(projectDir, 'Test Project');

    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-lifecycle.md');
    const destPath = join(projectDir, '.claude', 'commands', '.test-lifecycle.md');

    // Step 1: Create a default v1 and a pre-existing project file v0 that differs.
    writeFileSync(newDefaultPath, '# Default v1\n');
    writeFileSync(destPath, '# Project v0 (outdated)\n');

    try {
      // Step 2: Bootstrap — should flag as outdated and record project checksum.
      const first = store.syncDefaults(projectDir);
      expect(first).toContain('commands/.test-lifecycle.md');
      expect(readFileSync(destPath, 'utf-8')).toBe('# Project v0 (outdated)\n');

      // Verify manifest recorded the PROJECT checksum, not the default's.
      const manifestPath = join(projectDir, '.claude', '.teamai-scaffold.json');
      const manifestAfterFirst = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const projectV0Checksum = 'sha256:' + createHash('sha256').update('# Project v0 (outdated)\n').digest('hex').slice(0, 16);
      expect(manifestAfterFirst.files['commands/.test-lifecycle.md']).toBe(projectV0Checksum);

      // Step 3: Update the default to v2.
      writeFileSync(newDefaultPath, '# Default v2 (updated)\n');

      // Step 4: Second run — projectChecksum === storedChecksum (v0 hash),
      // so the file is treated as uncustomized and gets updated with default v2.
      const second = store.syncDefaults(projectDir);
      expect(second).toContain('commands/.test-lifecycle.md');
      expect(readFileSync(destPath, 'utf-8')).toBe('# Default v2 (updated)\n');

      // Manifest should now have the v2 default checksum.
      const manifestAfterSecond = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const defaultV2Checksum = 'sha256:' + createHash('sha256').update('# Default v2 (updated)\n').digest('hex').slice(0, 16);
      expect(manifestAfterSecond.files['commands/.test-lifecycle.md']).toBe(defaultV2Checksum);

      // Step 5: Third run — storedChecksum === currentChecksum, no changes.
      const third = store.syncDefaults(projectDir);
      expect(third).not.toContain('commands/.test-lifecycle.md');
    } finally {
      if (existsSync(newDefaultPath)) unlinkSync(newDefaultPath);
      if (existsSync(destPath)) unlinkSync(destPath);
    }
  });

  it('syncDefaults preserves a customised project file even when the default is updated', () => {
    // Register and establish a manifest baseline
    store.add(projectDir, 'Test Project');

    const newDefaultPath = join(process.cwd(), 'defaults', 'commands', '.test-new-command-2.md');
    const destPath = join(projectDir, '.claude', 'commands', '.test-new-command-2.md');

    // First: create the default and sync so the manifest records its checksum
    writeFileSync(newDefaultPath, '# Original default\n');
    store.syncDefaults(projectDir);

    try {
      // User customises the project file
      writeFileSync(destPath, '# My custom version\n');

      // Default is updated in TeamAI
      writeFileSync(newDefaultPath, '# Updated default\n');

      const updated = store.syncDefaults(projectDir);
      // Customised file must NOT be updated
      expect(updated).not.toContain('commands/.test-new-command-2.md');
      expect(readFileSync(destPath, 'utf-8')).toBe('# My custom version\n');
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
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
      retryOnLock(() => writeFileSync(defaultImplSrc, defaultBackup));
    }
  });

  // ── _updateGitignore ───────────────────────────────────────────────────

  it('_updateGitignore creates .gitignore with TeamAI exclusions when none exists', () => {
    const gitignorePath = join(projectDir, '.gitignore');
    expect(existsSync(gitignorePath)).toBe(false);

    (store as any)._updateGitignore(projectDir);

    expect(existsSync(gitignorePath)).toBe(true);
    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('# TeamAI — exclude transient pipeline files');
    expect(content).toContain('.teamai/*');
  });

  it('_updateGitignore appends TeamAI exclusions when .gitignore exists without them', () => {
    const gitignorePath = join(projectDir, '.gitignore');
    writeFileSync(gitignorePath, 'node_modules/\n.env\n');

    (store as any)._updateGitignore(projectDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    // Original content preserved
    expect(content).toContain('node_modules/');
    expect(content).toContain('.env');
    // TeamAI exclusions appended
    expect(content).toContain('# TeamAI — exclude transient pipeline files');
    expect(content).toContain('.teamai/*');
  });

  it('_updateGitignore is a no-op when the TeamAI pattern is already present', () => {
    const gitignorePath = join(projectDir, '.gitignore');
    const original = [
      'node_modules/',
      '.env',
      '',
      '# TeamAI — exclude transient pipeline files',
      '.teamai/*',
    ].join('\n') + '\n';
    writeFileSync(gitignorePath, original);

    (store as any)._updateGitignore(projectDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toBe(original);
  });

  it('_updateGitignore appends the TeamAI pattern when not already present', () => {
    const gitignorePath = join(projectDir, '.gitignore');
    writeFileSync(gitignorePath, [
      'node_modules/',
      '.env',
    ].join('\n') + '\n');

    (store as any)._updateGitignore(projectDir);

    const content = readFileSync(gitignorePath, 'utf-8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('.teamai/*');
    expect(content).toContain('# TeamAI — exclude transient pipeline files');
  });

  it('_updateGitignore does not throw when .gitignore is write-protected, but logs a warning', async () => {
    // Pre-create .gitignore without the TeamAI block and make it read-only.
    const giPath = join(projectDir, '.gitignore');
    writeFileSync(giPath, 'node_modules/\n');

    const { chmodSync, constants } = await import('fs');
    chmodSync(giPath, constants.S_IRUSR);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Must not throw, but the failure must be surfaced (not silent).
      expect(() => (store as any)._updateGitignore(projectDir)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      chmodSync(giPath, constants.S_IRUSR | constants.S_IWUSR);
    }
  });

  // ── _updateGitattributes ────────────────────────────────────────────────

  it('_updateGitattributes creates .gitattributes with TeamAI normalization when none exists', () => {
    const gitattributesPath = join(projectDir, '.gitattributes');
    expect(existsSync(gitattributesPath)).toBe(false);

    (store as any)._updateGitattributes(projectDir);

    expect(existsSync(gitattributesPath)).toBe(true);
    const content = readFileSync(gitattributesPath, 'utf-8');
    expect(content).toContain('# TeamAI — consistent line-ending normalization across host and container');
    expect(content).toContain('* text=auto eol=lf');
  });

  it('_updateGitattributes appends TeamAI block when .gitattributes exists without it', () => {
    const gitattributesPath = join(projectDir, '.gitattributes');
    writeFileSync(gitattributesPath, '*.js text eol=lf\n');

    (store as any)._updateGitattributes(projectDir);

    const content = readFileSync(gitattributesPath, 'utf-8');
    // Original content preserved
    expect(content).toContain('*.js text eol=lf');
    // TeamAI block appended
    expect(content).toContain('# TeamAI — consistent line-ending normalization across host and container');
    expect(content).toContain('* text=auto eol=lf');
  });

  it('_updateGitattributes is a no-op when the TeamAI block is already present', () => {
    const gitattributesPath = join(projectDir, '.gitattributes');
    const original = [
      '*.js text eol=lf',
      '',
      '# TeamAI — consistent line-ending normalization across host and container',
      '* text=auto eol=lf',
    ].join('\n') + '\n';
    writeFileSync(gitattributesPath, original);

    (store as any)._updateGitattributes(projectDir);

    const content = readFileSync(gitattributesPath, 'utf-8');
    expect(content).toBe(original);
  });

  it('_updateGitattributes appends missing TeamAI lines when only some are present', () => {
    const gitattributesPath = join(projectDir, '.gitattributes');
    // Only has the comment line but not the policy line
    writeFileSync(gitattributesPath, [
      '*.js text eol=lf',
      '',
      '# TeamAI — consistent line-ending normalization across host and container',
    ].join('\n') + '\n');

    (store as any)._updateGitattributes(projectDir);

    const content = readFileSync(gitattributesPath, 'utf-8');
    expect(content).toContain('*.js text eol=lf');
    expect(content).toContain('* text=auto eol=lf');
    // The comment should appear exactly once
    const commentCount = (content.match(/# TeamAI — consistent line-ending/g) || []).length;
    expect(commentCount).toBe(1);
  });

  it('_updateGitattributes writes renormalize-suggestion marker file when block is first added', () => {
    const markerPath = join(projectDir, '.teamai', 'gitattributes-renormalize-suggestion');
    expect(existsSync(markerPath)).toBe(false);

    // Brand-new — no .gitattributes exists
    const result = (store as any)._updateGitattributes(projectDir);
    expect(result).toBe(true);
    expect(existsSync(markerPath)).toBe(true);

    // Clean up marker and call again — block already present, should be no-op
    unlinkSync(markerPath);
    const result2 = (store as any)._updateGitattributes(projectDir);
    expect(result2).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('_updateGitattributes writes marker when block is appended to existing .gitattributes', () => {
    const markerPath = join(projectDir, '.teamai', 'gitattributes-renormalize-suggestion');
    // Pre-create .gitattributes without the TeamAI block
    writeFileSync(join(projectDir, '.gitattributes'), '*.js text eol=lf\n');
    mkdirSync(join(projectDir, '.teamai'), { recursive: true });

    const result = (store as any)._updateGitattributes(projectDir);
    expect(result).toBe(true);
    expect(existsSync(markerPath)).toBe(true);
  });

  it('_updateGitattributes does not write marker when block is already present (no-op)', () => {
    const markerPath = join(projectDir, '.teamai', 'gitattributes-renormalize-suggestion');
    const gitattributesPath = join(projectDir, '.gitattributes');
    writeFileSync(gitattributesPath, [
      '# TeamAI — consistent line-ending normalization across host and container',
      '* text=auto eol=lf',
    ].join('\n') + '\n');

    const result = (store as any)._updateGitattributes(projectDir);
    expect(result).toBe(false);
    expect(existsSync(markerPath)).toBe(false);
  });

  it('_updateGitattributes does not throw when .gitattributes is write-protected (best-effort)', async () => {
    // Pre-create .gitattributes without the TeamAI block and make it
    // read-only so appendFileSync throws EPERM.
    const gaPath = join(projectDir, '.gitattributes');
    writeFileSync(gaPath, '*.js text eol=lf\n');

    const { chmodSync, constants } = await import('fs');
    // Make the file read-only (owner-read only — no write permission).
    chmodSync(gaPath, constants.S_IRUSR);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Must not throw, but the failure must be surfaced (not silent).
      expect(() => (store as any)._updateGitattributes(projectDir)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      // Restore write permission so the test dir can be cleaned up.
      chmodSync(gaPath, constants.S_IRUSR | constants.S_IWUSR);
    }
  });

  it('_updateGitattributes does not throw when .gitattributes cannot be created, but logs a warning', async () => {
    // Place a directory at .gitattributes so writeFileSync fails with EISDIR.
    const gaPath = join(projectDir, '.gitattributes');
    const { mkdirSync: mkdir, rmdirSync: rmdir } = await import('fs');
    mkdir(gaPath);

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Must not throw, but the failure must be surfaced (not silent).
      expect(() => (store as any)._updateGitattributes(projectDir)).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      rmdir(gaPath);
    }
  });

});

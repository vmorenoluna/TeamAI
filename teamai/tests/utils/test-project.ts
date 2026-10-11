/**
 * Test Project Lifecycle Utility
 *
 * Creates temporary project directories for tests and ensures they are
 * cleaned up. They live in the OS temp dir, never inside the repo, so a test
 * (or a git command it runs) can't resolve to or modify the real checkout.
 *
 * Usage in beforeEach/afterEach:
 *   let cleanup: () => void;
 *   beforeEach(() => {
 *     const { root, clean } = createTestProject();
 *     testDir = root;
 *     cleanup = clean;
 *   });
 *   afterEach(() => cleanup());
 */

import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const TEST_PREFIX = '.teamai-test-';

/**
 * Creates a temporary test project directory (NOT registered in ProjectStore).
 * Returns the project root path and a clean() function.
 */
export function createTestProject(): { root: string; clean: () => void } {
  const root = join(tmpdir(), TEST_PREFIX + randomUUID().slice(0, 8));
  mkdirSync(root, { recursive: true });

  const clean = () => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, clean };
}

/**
 * Unit tests for the roles server actions.
 * Focused on deterministic ordering of the role list (readdirSync order is
 * filesystem-dependent, so getRoles must sort before returning).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { createTestProject } from '../utils/test-project';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// ── Tests ───────────────────────────────────────────────────────────────────

describe('roles server actions', () => {
  let root: string;
  let clean: () => void;

  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mockGetActiveProjectPath.mockResolvedValue(root);
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('getRoles returns roles in deterministic (sorted) filename order', async () => {
    const rolesDir = join(root, '.claude', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    // Write in a deliberately non-alphabetical order.
    writeFileSync(join(rolesDir, 'planner.md'), '# Role: Planner\n');
    writeFileSync(join(rolesDir, 'analyst.md'), '# Role: Analyst\n');
    writeFileSync(join(rolesDir, 'coder.md'), '# Role: Coder\n');

    const { getRoles } = await import('@/app/actions/roles');
    const roles = await getRoles();

    expect(roles.map(r => r.filename)).toEqual(['analyst.md', 'coder.md', 'planner.md']);
  });
});

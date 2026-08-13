/**
 * Unit tests for references server actions.
 *
 * Tests cover uploadTaskReference (file write, revalidatePath, error propagation)
 * and getTaskReferences (listing, missing dir, error handling).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetActiveProjectPath = vi.fn();
const mockRevalidatePath = vi.fn();

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: (...args: unknown[]) => mockGetActiveProjectPath(...args),
}));

vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => mockRevalidatePath(...args),
}));

vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    projectPath: string;
    constructor(projectPath: string) {
      this.projectPath = projectPath;
    }
    getDirById = vi.fn((id: string) => join(this.projectPath, '.teamai', id));
  },
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

import { createTestProject } from '../utils/test-project';

function makeFormData(contents: Buffer, fileName = 'test-image.png'): FormData {
  const formData = new FormData();
  const file = new File([contents as BlobPart], fileName, { type: 'image/png' });
  formData.set('file', file);
  return formData;
}

let root: string;
let clean: () => void;

// ── Tests ───────────────────────────────────────────────────────────────────

describe('references server actions', () => {
  beforeEach(() => {
    const project = createTestProject();
    root = project.root;
    clean = project.clean;
    mkdirSync(join(root, '.teamai'), { recursive: true });
    mockGetActiveProjectPath.mockResolvedValue(root);
  });

  afterEach(() => {
    clean();
    vi.clearAllMocks();
    vi.resetModules();
  });

  // ── uploadTaskReference ───────────────────────────────────────────────

  describe('uploadTaskReference', () => {
    it('writes the uploaded file to taskDir/references/', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      const formData = makeFormData(Buffer.from('fake-image-data'), 'screenshot.png');

      const dest = await uploadTaskReference('task-1', formData);

      // File should exist at the returned path
      expect(existsSync(dest)).toBe(true);

      // Path should be inside taskDir/references/
      expect(dest).toContain(join('.teamai', 'task-1', 'references', 'ref-'));
      // Filename is a UUID (not a millisecond timestamp) so concurrent
      // uploads can never collide.
      expect(dest).toMatch(/ref-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.png$/);
    });

    it('defaults to .png extension when file has no extension', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      const formData = makeFormData(Buffer.from('data'), 'noext');

      const dest = await uploadTaskReference('task-1', formData);

      expect(dest).toMatch(/\.png$/);
      expect(existsSync(dest)).toBe(true);
    });

    it('preserves the original file extension (e.g. .jpg)', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      const formData = makeFormData(Buffer.from('jpeg-data'), 'photo.jpg');

      const dest = await uploadTaskReference('task-2', formData);

      expect(dest).toMatch(/\.jpg$/);
      expect(existsSync(dest)).toBe(true);
    });

    it('writes correct file contents', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      const contents = Buffer.from('actual-binary-data-here');
      const formData = makeFormData(contents);

      const dest = await uploadTaskReference('task-1', formData);

      const { readFileSync } = await import('fs');
      const written = readFileSync(dest);
      expect(written.equals(contents)).toBe(true);
    });

    it('calls revalidatePath for root and task detail page', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      mockRevalidatePath.mockClear();

      await uploadTaskReference('task-42', makeFormData(Buffer.from('test')));

      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledWith('/task/task-42');
      expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
    });

    it('uses the active project path from getActiveProjectPath', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      await uploadTaskReference('task-1', makeFormData(Buffer.from('test')));

      expect(mockGetActiveProjectPath).toHaveBeenCalledTimes(1);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project selected'));

      const { uploadTaskReference } = await import('@/app/actions/references');
      await expect(
        uploadTaskReference('task-1', makeFormData(Buffer.from('test'))),
      ).rejects.toThrow('no project selected');
    });

    it('creates the references directory if it does not exist', async () => {
      // Remove any pre-existing .teamai/task-X/references dir
      const refDir = join(root, '.teamai', 'task-1', 'references');
      if (existsSync(refDir)) rmSync(refDir, { recursive: true, force: true });

      const { uploadTaskReference } = await import('@/app/actions/references');
      await uploadTaskReference('task-1', makeFormData(Buffer.from('test')));

      expect(existsSync(refDir)).toBe(true);
    });

    it('throws when FormData is missing the file field', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');
      const emptyFormData = new FormData();

      await expect(
        uploadTaskReference('task-1', emptyFormData),
      ).rejects.toThrow();

      // Should not write any file or call revalidatePath
      expect(mockRevalidatePath).not.toHaveBeenCalled();
    });

    it('handles multiple uploads for the same task (unique filenames)', async () => {
      const { uploadTaskReference } = await import('@/app/actions/references');

      const dest1 = await uploadTaskReference('task-1', makeFormData(Buffer.from('a'), 'img1.png'));
      const dest2 = await uploadTaskReference('task-1', makeFormData(Buffer.from('b'), 'img2.png'));

      expect(dest1).not.toBe(dest2);
      expect(existsSync(dest1)).toBe(true);
      expect(existsSync(dest2)).toBe(true);
    });
  });

  // ── getTaskReferences ─────────────────────────────────────────────────

  describe('getTaskReferences', () => {
    it('returns an empty array when no references directory exists', async () => {
      const { getTaskReferences } = await import('@/app/actions/references');

      const refs = await getTaskReferences('task-no-refs');

      expect(refs).toEqual([]);
    });

    it('returns the list of image files in the references directory', async () => {
      // First upload some references
      const { uploadTaskReference } = await import('@/app/actions/references');
      await uploadTaskReference('task-1', makeFormData(Buffer.from('a'), 'img1.png'));
      await uploadTaskReference('task-1', makeFormData(Buffer.from('b'), 'img2.jpg'));

      const { getTaskReferences } = await import('@/app/actions/references');
      const refs = await getTaskReferences('task-1');

      expect(refs.length).toBe(2);
      expect(refs.every(f => /\.(png|jpg)$/i.test(f))).toBe(true);
    });

    it('filters out non-image files', async () => {
      // Upload images
      const { uploadTaskReference } = await import('@/app/actions/references');
      await uploadTaskReference('task-3', makeFormData(Buffer.from('img'), 'pic.png'));

      // Manually write a non-image file into the references dir
      const refDir = join(root, '.teamai', 'task-3', 'references');
      const { writeFileSync } = await import('fs');
      writeFileSync(join(refDir, 'readme.txt'), 'not an image');

      const { getTaskReferences } = await import('@/app/actions/references');
      const refs = await getTaskReferences('task-3');

      expect(refs.length).toBe(1);
      expect(refs[0]).toMatch(/\.png$/i);
    });

    it('propagates error when getActiveProjectPath fails', async () => {
      mockGetActiveProjectPath.mockRejectedValue(new Error('no project'));

      const { getTaskReferences } = await import('@/app/actions/references');
      await expect(getTaskReferences('task-1')).rejects.toThrow('no project');
    });

    it('returns references in deterministic (sorted) order', async () => {
      const refDir = join(root, '.teamai', 'task-4', 'references');
      mkdirSync(refDir, { recursive: true });
      const { writeFileSync } = await import('fs');
      // Write in a deliberately non-alphabetical order — readdirSync order is
      // filesystem-dependent, so the action must sort before returning.
      writeFileSync(join(refDir, 'ref-zeta.png'), 'z');
      writeFileSync(join(refDir, 'ref-alpha.png'), 'a');
      writeFileSync(join(refDir, 'ref-mid.jpg'), 'm');

      const { getTaskReferences } = await import('@/app/actions/references');
      const refs = await getTaskReferences('task-4');

      expect(refs).toEqual(['ref-alpha.png', 'ref-mid.jpg', 'ref-zeta.png']);
    });
  });
});

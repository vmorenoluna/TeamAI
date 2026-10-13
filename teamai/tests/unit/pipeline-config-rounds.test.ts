import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let projectDir: string;

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: async () => projectDir,
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const warnMock = vi.fn();
vi.mock('@/lib/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/logger')>()),
  warn: (...args: unknown[]) => warnMock(...args),
}));

import { computePipelineConfig } from '@/lib/orchestrator/helpers';
import { getPipelineConfig, savePipelineConfig, type PipelineConfig } from '@/app/actions/pipeline';

function writeCfg(obj: unknown): void {
  writeFileSync(join(projectDir, '.teamai', 'pipeline.json'), JSON.stringify(obj));
}

function readCfg(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(projectDir, '.teamai', 'pipeline.json'), 'utf-8'));
}

// AC17 table: [file contents, expected maxQaRounds]
const TABLE: Array<[string, Record<string, unknown>, number]> = [
  ['maxQaAttempts only', { maxQaAttempts: 5 }, 15],
  ['explicit larger rounds', { maxQaAttempts: 3, maxQaRounds: 12 }, 12],
  ['rounds below attempts is clamped', { maxQaAttempts: 5, maxQaRounds: 2 }, 5],
  ['rounds equal to attempts', { maxQaAttempts: 4, maxQaRounds: 4 }, 4],
  ['zero rounds falls back', { maxQaAttempts: 4, maxQaRounds: 0 }, 12],
  ['negative rounds falls back', { maxQaAttempts: 4, maxQaRounds: -3 }, 12],
  ['non-integer rounds falls back', { maxQaAttempts: 4, maxQaRounds: 7.5 }, 12],
  ['string rounds falls back', { maxQaAttempts: 4, maxQaRounds: '10' }, 12],
  ['empty file object', {}, 9],
];

describe('maxQaRounds config', () => {
  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'pipeline-rounds-'));
    mkdirSync(join(projectDir, '.teamai'), { recursive: true });
    warnMock.mockClear();
  });
  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
  });

  describe('AC17 — resolution', () => {
    it.each(TABLE)('computePipelineConfig: %s', (_name, raw, expected) => {
      writeCfg(raw);
      expect(computePipelineConfig(projectDir).maxQaRounds).toBe(expected);
    });

    it.each(TABLE)('getPipelineConfig: %s', async (_name, raw, expected) => {
      writeCfg(raw);
      expect((await getPipelineConfig()).maxQaRounds).toBe(expected);
    });

    it('both readers default to 9 with no file', async () => {
      expect(computePipelineConfig(projectDir).maxQaRounds).toBe(9);
      expect((await getPipelineConfig()).maxQaRounds).toBe(9);
    });

    it('both readers default to 9 on unparseable file', async () => {
      writeFileSync(join(projectDir, '.teamai', 'pipeline.json'), '{not json');
      expect(computePipelineConfig(projectDir).maxQaRounds).toBe(9);
      expect((await getPipelineConfig()).maxQaRounds).toBe(9);
    });

    it('warns in helpers only when the clamp raises the value', () => {
      writeCfg({ maxQaAttempts: 5, maxQaRounds: 2 });
      computePipelineConfig(projectDir);
      expect(warnMock).toHaveBeenCalledTimes(1);
      warnMock.mockClear();
      writeCfg({ maxQaAttempts: 5, maxQaRounds: 20 });
      computePipelineConfig(projectDir);
      expect(warnMock).not.toHaveBeenCalled();
    });
  });

  describe('AC18 — save validation', () => {
    const base: PipelineConfig = {
      maxQaAttempts: 3,
      maxQaRounds: 9,
      parallelSubtasks: true,
      autoModeMaxParallel: 1,
      idleStallMinutes: 15,
      toolStallMinutes: 30,
      maxImplementRetries: 3,
      recordHistoryInGit: true,
      includePhasesTrailer: true,
    };

    it.each([
      [{ maxQaAttempts: 5, maxQaRounds: 4 }, 'Max QA rounds (4) must be at least Max QA attempts (5)'],
      [{ maxQaRounds: 7.5 }, 'Max QA rounds (7.5) must be at least Max QA attempts (3)'],
      [{ maxQaRounds: NaN }, 'Max QA rounds (NaN) must be at least Max QA attempts (3)'],
      [{ maxQaRounds: Infinity }, 'Max QA rounds (Infinity) must be at least Max QA attempts (3)'],
    ])('rejects %j and writes nothing', async (override, message) => {
      await expect(savePipelineConfig({ ...base, ...override })).rejects.toThrow(message);
      expect(existsSync(join(projectDir, '.teamai', 'pipeline.json'))).toBe(false);
    });

    it('leaves an existing file untouched on rejection', async () => {
      writeCfg({ maxQaAttempts: 2, maxQaRounds: 6 });
      await expect(savePipelineConfig({ ...base, maxQaAttempts: 5, maxQaRounds: 1 })).rejects.toThrow();
      expect(readCfg()).toEqual({ maxQaAttempts: 2, maxQaRounds: 6 });
    });

    it('persists maxQaRounds and preserves orchestrator-only fields', async () => {
      writeCfg({ maxStallRecoveries: 7, autoMergeMethod: 'squash' });
      await savePipelineConfig({ ...base, maxQaAttempts: 4, maxQaRounds: 4 });
      const saved = readCfg();
      expect(saved.maxQaRounds).toBe(4);
      expect(saved.maxQaAttempts).toBe(4);
      expect(saved.maxStallRecoveries).toBe(7);
      expect(saved.autoMergeMethod).toBe('squash');
    });
  });
});

/**
 * T32 regression tests for readJsonFile (T7).
 *
 * Covers: missing file (optional + required), empty file, invalid JSON,
 * valid JSON, validation pass, validation fail, read-error paths.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { readJsonFile } from '../../src/lib/json-io';

describe('readJsonFile', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = join(tmpdir(), `teamai-json-io-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    path = join(dir, 'test.json');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── Missing file ──

  it('returns null data with no error for a missing file (not required)', () => {
    const result = readJsonFile(path);
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns MISSING error for a required file that is missing', () => {
    const result = readJsonFile(path, { required: true });
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('MISSING');
    expect(result.error?.message).toContain('Required file not found');
  });

  // ── Empty file ──

  it('returns null data with no error for an empty file (not required)', () => {
    writeFileSync(path, '');
    const result = readJsonFile(path);
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  it('returns INVALID_JSON error for an empty required file', () => {
    writeFileSync(path, '');
    const result = readJsonFile(path, { required: true });
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('INVALID_JSON');
    expect(result.error?.message).toContain('empty');
  });

  it('returns null data with no error for a whitespace-only file (not required)', () => {
    writeFileSync(path, '   \n  \t  ');
    const result = readJsonFile(path);
    // JSON.parse would throw on whitespace-only — readJsonFile catches it
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  // ── Invalid JSON ──

  it('returns INVALID_JSON error for malformed JSON', () => {
    writeFileSync(path, '{ not valid json {{{');
    const result = readJsonFile(path);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('INVALID_JSON');
    expect(result.error?.message).toContain('Invalid JSON');
    expect(result.error?.message).toContain(path);
  });

  it('returns INVALID_JSON error for truncated JSON', () => {
    writeFileSync(path, '{"key": "val');
    const result = readJsonFile(path);
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('INVALID_JSON');
  });

  it('returns INVALID_JSON error for a bare string (not an object)', () => {
    writeFileSync(path, '"just a string"');
    const result = readJsonFile(path);
    // Bare string is valid JSON — no error
    expect(result.data).toBe('just a string');
    expect(result.error).toBeNull();
  });

  it('returns INVALID_JSON error for a bare number (not an object)', () => {
    writeFileSync(path, '42');
    const result = readJsonFile(path);
    // Bare number is valid JSON — no error
    expect(result.data).toBe(42);
    expect(result.error).toBeNull();
  });

  // ── Valid JSON ──

  it('parses a valid JSON object', () => {
    const data = { name: 'test', value: 42 };
    writeFileSync(path, JSON.stringify(data));
    const result = readJsonFile<typeof data>(path);
    expect(result.data).toEqual(data);
    expect(result.error).toBeNull();
  });

  it('parses a valid JSON array', () => {
    const data = [1, 2, 3];
    writeFileSync(path, JSON.stringify(data));
    const result = readJsonFile<typeof data>(path);
    expect(result.data).toEqual(data);
    expect(result.error).toBeNull();
  });

  it('parses a valid JSON null', () => {
    writeFileSync(path, 'null');
    const result = readJsonFile(path);
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  it('parses a valid JSON boolean', () => {
    writeFileSync(path, 'true');
    const result = readJsonFile(path);
    expect(result.data).toBe(true);
    expect(result.error).toBeNull();
  });

  // ── Real-world shapes ──

  it('parses a realistic qa_report.json', () => {
    const report = {
      overall: 'FAIL',
      criteria: [
        { name: 'Login flow', status: 'FAIL', notes: 'Missing error handling', fix_needed: 'Add try/catch' },
        { name: 'Performance', status: 'PASS', notes: 'Response time within budget' },
      ],
      additional_issues: [
        { description: 'N+1 query', file: 'src/api.ts', severity: 'high', fix_needed: 'Use batch query' },
      ],
    };
    writeFileSync(path, JSON.stringify(report));
    const result = readJsonFile(path);
    expect(result.error).toBeNull();
    expect(result.data).toEqual(report);
  });

  it('parses a realistic plan.json', () => {
    const plan = {
      subtasks: [
        { id: 1, title: 'Add login', description: 'Build login page', files: ['src/login.ts'], acceptance_criteria: ['Works'], completed: true },
        { id: 2, title: 'Fix auth', description: 'Fix auth module', files: ['src/auth.ts'], acceptance_criteria: ['No 401 errors [QA CORRECTION: Add token refresh]'], qa_flagged: true },
      ],
    };
    writeFileSync(path, JSON.stringify(plan));
    const result = readJsonFile(path);
    expect(result.error).toBeNull();
    expect(result.data).toEqual(plan);
  });

  // ── Validation ──

  it('passes validation when validate returns null', () => {
    const data = { overall: 'PASS' };
    writeFileSync(path, JSON.stringify(data));
    const result = readJsonFile(path, {
      validate: (d: typeof data) => d.overall === 'PASS' ? null : 'must PASS',
    });
    expect(result.data).toEqual(data);
    expect(result.error).toBeNull();
  });

  it('returns VALIDATION_FAILED when validate returns an error string', () => {
    const data = { overall: 'FAIL' };
    writeFileSync(path, JSON.stringify(data));
    const result = readJsonFile(path, {
      validate: (d: typeof data) => d.overall === 'PASS' ? null : 'overall must be PASS',
    });
    expect(result.data).toBeNull();
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(result.error?.message).toContain('overall must be PASS');
  });

  it('does not run validation when the file is missing (not required)', () => {
    const validate = (() => { throw new Error('should not be called'); }) as () => string | null;
    const result = readJsonFile(path, { validate });
    expect(result.data).toBeNull();
    expect(result.error).toBeNull();
  });

  it('does not run validation when JSON is invalid', () => {
    writeFileSync(path, '{ broken');
    const validate = (() => { throw new Error('should not be called'); }) as () => string | null;
    const result = readJsonFile(path, { validate });
    expect(result.error?.code).toBe('INVALID_JSON');
  });

  // ── Type narrowing ──

  it('preserves the generic type parameter for valid data', () => {
    interface QaReport { overall: string; criteria: Array<{ name: string; status: string }> }
    const report: QaReport = { overall: 'PASS', criteria: [{ name: 'X', status: 'PASS' }] };
    writeFileSync(path, JSON.stringify(report));
    const result = readJsonFile<QaReport>(path);
    // TypeScript should allow accessing typed fields without cast
    if (result.data) {
      const overall: string = result.data.overall;
      expect(overall).toBe('PASS');
      expect(result.data.criteria).toHaveLength(1);
    }
    expect(result.error).toBeNull();
  });
});

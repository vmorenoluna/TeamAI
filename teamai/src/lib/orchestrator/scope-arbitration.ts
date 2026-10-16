/**
 * Scope arbitration — what happens to the files a coder changed outside its subtask's `files`.
 *
 * The implement phase holds such a subtask's commits and writes `scope_report-st<N>.json`.
 * The planner then approves or rejects each unlisted file once per implement pass
 * (`scope_verdicts.json`); approved work is integrated without a re-run, rejected paths are
 * dropped. Progress and budgets are tracked per scope-progress.ts.
 *
 * Own narrow deps interface (no import of implement.ts) so implement.ts can wire it in.
 */
import { existsSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import { renderCommand } from '../command-templates';
import { updateSessionMap, logToOutput } from './helpers';
import { WorktreeError } from './errors';
import { ORCHESTRATOR_FAIL_TYPE } from './types';
import type { TaskPipeline, PlanSubtask, ScopeRoundRecord, SessionOptsResult } from './types';
import type { AgentSession } from '../process-manager';
import { assessScopeProgress, buildScopeRoundRecord, scopeBudgetExhausted, scopeFileKey } from './scope-progress';

// ── Types ─────────────────────────────────────────────────────────────────

export interface ScopeReportFile {
  path: string;
  insertions: number | null;
  deletions: number | null;
  coder_reason: string | null;
}

export interface ScopeReport {
  subtask_id: number;
  base: string;
  session_head: string;
  /** Branch holding the subtask's commits, or null when they were left in place on the feature branch. */
  held_ref: string | null;
  declared_files: string[];
  unlisted: ScopeReportFile[];
  created_at: string;
}

export interface ScopeRejection {
  path: string;
  reason: string;
}

export interface ScopeVerdictsFile {
  verdicts?: Array<{ subtask_id: number; path: string; verdict: string; reason: string }>;
  serialize?: Array<{ subtask_id: number; parallel_group?: string; depends_on?: number[] }>;
}

type ScopePipeline = TaskPipeline;

export interface ScopeArbitrationDeps {
  projectRoot: string;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  /** Waits for the planner session to finish (injectable so tests can write the verdicts file). */
  waitForCompletion: (sessionId: string) => Promise<void>;
  toAgentPath: (hostPath: string) => string;
  planWriteLock: { current: Promise<void> };
  savePipelineState: (pipeline: ScopePipeline) => void;
  execGit: (args: string[], hostCwd: string) => Promise<void>;
  execGitCapture: (args: string[], hostCwd: string) => Promise<string>;
  tryCherryPickWithRecovery: (pipeline: ScopePipeline, logFile: string, stBranch: string, subtaskId: number) => Promise<boolean>;
  verifySubtaskDeliverables: (pipeline: ScopePipeline, subtask: PlanSubtask, cwd: string) => Promise<'ok' | 'incomplete' | 'failed'>;
  filesAlreadyChangedOnBranch: (cwd: string, files: string[]) => Promise<boolean>;
  completeSubtask: (
    pipeline: ScopePipeline, subtask: PlanSubtask, cwd: string, preSessionHead: string, completedIds: number[],
  ) => Promise<boolean>;
}

export interface ScopeBudgetConfig {
  maxScopeStall: number;
  maxScopeReplans: number;
}

// ── Report I/O ────────────────────────────────────────────────────────────

const REPORT_RE = /^scope_report-st(\d+)\.json$/;

function atomicWriteJson(file: string, value: unknown): void {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(readFileSync(file, 'utf-8')) as T; } catch { return null; }
}

export function scopeReportPath(specPath: string, subtaskId: number): string {
  return path.join(specPath, `scope_report-st${subtaskId}.json`);
}

function readScopeNotes(specPath: string, subtaskId: number): Map<string, string> {
  const notesPath = path.join(specPath, `scope_notes-st${subtaskId}.json`);
  const notes = new Map<string, string>();
  if (!existsSync(notesPath)) return notes;
  try {
    const parsed = JSON.parse(readFileSync(notesPath, 'utf-8')) as { files?: unknown };
    if (!parsed || !Array.isArray(parsed.files)) throw new Error('missing files array');
    for (const entry of parsed.files) {
      const e = entry as { path?: unknown; reason?: unknown };
      if (typeof e?.path === 'string' && typeof e.reason === 'string') notes.set(e.path.replace(/\\/g, '/'), e.reason);
    }
  } catch {
    logToOutput(specPath, `[SCOPE] Ignoring malformed scope_notes-st${subtaskId}.json\n`);
  }
  try { unlinkSync(notesPath); } catch { /* best-effort */ }
  return notes;
}

async function numstatFor(
  deps: Pick<ScopeArbitrationDeps, 'execGitCapture'>, cwd: string, base: string, head: string, file: string,
): Promise<{ insertions: number | null; deletions: number | null }> {
  try {
    const line = (await deps.execGitCapture(['diff', '--numstat', base, head, '--', file], cwd)).trim().split('\n')[0] ?? '';
    const [ins, del] = line.split('\t');
    const toNum = (v: string | undefined) => (v === undefined || v === '-' || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
    return { insertions: toNum(ins), deletions: toNum(del) };
  } catch {
    return { insertions: null, deletions: null };
  }
}

/** Write `scope_report-st<N>.json` for a held subtask and consume its `scope_notes-st<N>.json`. */
export async function writeScopeReport(
  deps: Pick<ScopeArbitrationDeps, 'execGitCapture'>,
  opts: {
    specPath: string; cwd: string; subtaskId: number; base: string; sessionHead: string;
    heldRef: string | null; declaredFiles: string[]; unlistedPaths: string[];
  },
): Promise<ScopeReport> {
  const notes = readScopeNotes(opts.specPath, opts.subtaskId);
  const unlisted: ScopeReport['unlisted'] = [];
  for (const p of opts.unlistedPaths) {
    unlisted.push({
      path: p,
      ...(await numstatFor(deps, opts.cwd, opts.base, opts.sessionHead, p)),
      coder_reason: notes.get(p) ?? null,
    });
  }
  const report: ScopeReport = {
    subtask_id: opts.subtaskId,
    base: opts.base,
    session_head: opts.sessionHead,
    held_ref: opts.heldRef,
    declared_files: opts.declaredFiles,
    unlisted,
    created_at: new Date().toISOString(),
  };
  atomicWriteJson(scopeReportPath(opts.specPath, opts.subtaskId), report);
  return report;
}

/** Every pending `scope_report-st<N>.json`, ordered by subtask id. */
export function listPendingScopeReports(specPath: string): ScopeReport[] {
  let names: string[] = [];
  try { names = readdirSync(specPath); } catch { return []; }
  return names
    .map(n => REPORT_RE.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => readJson<ScopeReport>(path.join(specPath, m[0])))
    .filter((r): r is ScopeReport => !!r && typeof r.subtask_id === 'number' && Array.isArray(r.unlisted))
    .sort((a, b) => a.subtask_id - b.subtask_id);
}

export function readScopeRejections(specPath: string): Record<string, ScopeRejection[]> {
  return readJson<Record<string, ScopeRejection[]>>(path.join(specPath, 'scope_rejections.json')) ?? {};
}

/** Cumulative record of planner rejections, shown to the coder on any re-run. */
export function appendScopeRejections(specPath: string, additions: Record<number, ScopeRejection[]>): void {
  const all = readScopeRejections(specPath);
  for (const [id, list] of Object.entries(additions)) {
    const existing = all[id] ?? [];
    for (const r of list) {
      if (!existing.some(e => e.path === r.path && e.reason === r.reason)) existing.push(r);
    }
    if (existing.length) all[id] = existing;
  }
  atomicWriteJson(path.join(specPath, 'scope_rejections.json'), all);
}

// ── Budget failure report ─────────────────────────────────────────────────

export interface ScopeExhausted {
  status: 'exhausted';
  budget: 'stall' | 'rounds';
  subtaskIds: number[];
  files: string[];
}

/** Write the FAIL `qa_report.json` that explains an exhausted scope-arbitration budget. */
export function writeScopeBudgetFailReport(specPath: string, exhausted: ScopeExhausted): void {
  const what = exhausted.budget === 'stall'
    ? 'consecutive scope-arbitration rounds without progress'
    : 'total scope-arbitration re-plans';
  writeFileSync(path.join(specPath, 'qa_report.json'), JSON.stringify({
    overall: 'FAIL',
    fail_type: ORCHESTRATOR_FAIL_TYPE,
    criteria: [{
      criterion: 'Scope arbitration budget',
      name: 'Scope arbitration budget',
      status: 'FAIL',
      notes: `The ${exhausted.budget} budget (${what}) was exhausted. Subtask(s) ${exhausted.subtaskIds.join(', ')} ` +
        `keep changing files outside their plan \`files\`: ${exhausted.files.join(', ')}`,
    }],
  }, null, 2));
}

// ── Verdict validation / application ──────────────────────────────────────

export interface ScopeApplyResult {
  valid: boolean;
  problems: string[];
  /** Plan with the verdicts applied (only meaningful when valid). */
  plan: { subtasks: PlanSubtask[] } & Record<string, unknown>;
  approvals: Record<number, string[]>;
  rejections: Record<number, ScopeRejection[]>;
  serializations: number;
}

function hasCycle(subtasks: PlanSubtask[]): boolean {
  const deps = new Map(subtasks.map(s => [s.id, s.depends_on ?? []]));
  const state = new Map<number, 1 | 2>();
  const visit = (id: number): boolean => {
    if (state.get(id) === 2) return false;
    if (state.get(id) === 1) return true;
    state.set(id, 1);
    for (const d of deps.get(id) ?? []) if (deps.has(d) && visit(d)) return true;
    state.set(id, 2);
    return false;
  };
  return [...deps.keys()].some(visit);
}

function dependsTransitively(subtasks: PlanSubtask[], from: number, to: number): boolean {
  const deps = new Map(subtasks.map(s => [s.id, s.depends_on ?? []]));
  const seen = new Set<number>();
  const stack = [from];
  while (stack.length) {
    const id = stack.pop() as number;
    for (const d of deps.get(id) ?? []) {
      if (d === to) return true;
      if (!seen.has(d)) { seen.add(d); stack.push(d); }
    }
  }
  return false;
}

/**
 * Validate `scope_verdicts.json` against the reports of this action and apply it to a copy of
 * the plan. Pure with respect to plan.json: the caller persists the returned plan when valid.
 */
export function validateScopeVerdicts(
  specPath: string, plan: { subtasks: PlanSubtask[] } & Record<string, unknown>, reports: ScopeReport[],
): ScopeApplyResult {
  const next = JSON.parse(JSON.stringify(plan)) as typeof plan;
  const result: ScopeApplyResult = { valid: false, problems: [], plan: next, approvals: {}, rejections: {}, serializations: 0 };
  const problems = result.problems;

  const verdictsPath = path.join(specPath, 'scope_verdicts.json');
  const file = existsSync(verdictsPath) ? readJson<ScopeVerdictsFile>(verdictsPath) : null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.verdicts)) {
    problems.push(existsSync(verdictsPath) ? 'scope_verdicts.json is not parseable or has no verdicts array' : 'scope_verdicts.json is missing');
    return result;
  }

  const actionIds = new Set(reports.map(r => r.subtask_id));
  const pairKey = (id: number, p: string) => `${id}\u0000${p}`;
  const expected = new Set(reports.flatMap(r => r.unlisted.map(u => pairKey(r.subtask_id, u.path))));
  const seen = new Map<string, { verdict: string; reason: string }[]>();
  for (const v of file.verdicts) {
    const key = pairKey(v?.subtask_id, v?.path);
    if (!expected.has(key)) {
      problems.push(`verdict for subtask ${v?.subtask_id} path ${v?.path} is not part of this arbitration`);
      continue;
    }
    seen.set(key, [...(seen.get(key) ?? []), { verdict: v.verdict, reason: v.reason }]);
  }
  for (const r of reports) {
    for (const u of r.unlisted) {
      const list = seen.get(pairKey(r.subtask_id, u.path)) ?? [];
      const label = `subtask ${r.subtask_id} ${u.path}`;
      if (list.length === 0) problems.push(`no verdict for ${label}`);
      else if (list.length > 1) problems.push(`several verdicts for ${label}`);
      else if (list[0].verdict !== 'approve' && list[0].verdict !== 'reject') problems.push(`verdict for ${label} must be approve or reject`);
      else if (typeof list[0].reason !== 'string' || !list[0].reason.trim()) problems.push(`verdict for ${label} has an empty reason`);
    }
  }

  const byId = new Map(next.subtasks.map(s => [s.id, s]));
  const serialize = Array.isArray(file.serialize) ? file.serialize : [];
  for (const s of serialize) {
    if (!actionIds.has(s?.subtask_id)) problems.push(`serialize entry names subtask ${s?.subtask_id}, which is not in this arbitration`);
    for (const d of s?.depends_on ?? []) {
      if (!byId.has(d)) problems.push(`serialize for subtask ${s.subtask_id} depends_on non-existent subtask ${d}`);
      else if (d === s.subtask_id) problems.push(`serialize for subtask ${s.subtask_id} depends_on itself`);
    }
  }
  if (problems.length > 0) return result;

  // Apply.
  for (const v of file.verdicts) {
    const sub = byId.get(v.subtask_id);
    if (!sub) { problems.push(`subtask ${v.subtask_id} is not in plan.json`); continue; }
    if (v.verdict === 'approve') {
      sub.files = [...new Set([...(sub.files ?? []), v.path])];
      (result.approvals[v.subtask_id] ??= []).push(v.path);
    } else {
      (result.rejections[v.subtask_id] ??= []).push({ path: v.path, reason: v.reason.trim() });
    }
  }
  for (const s of serialize) {
    const sub = byId.get(s.subtask_id);
    if (!sub) continue;
    if (typeof s.parallel_group === 'string' && s.parallel_group) sub.parallel_group = s.parallel_group;
    if (s.depends_on?.length) sub.depends_on = [...new Set([...(sub.depends_on ?? []), ...s.depends_on])];
    result.serializations++;
  }
  if (problems.length > 0) return result;

  if (hasCycle(next.subtasks)) { problems.push('depends_on graph has a cycle'); return result; }

  const groups = new Map<string, PlanSubtask[]>();
  for (const s of next.subtasks) if (s.parallel_group) groups.set(s.parallel_group, [...(groups.get(s.parallel_group) ?? []), s]);
  for (const [group, members] of groups) {
    if (!members.some(m => actionIds.has(m.id))) continue;
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i]; const b = members[j];
        if (dependsTransitively(next.subtasks, a.id, b.id) || dependsTransitively(next.subtasks, b.id, a.id)) continue;
        const aPaths = new Set([...(a.files ?? []), ...(a.files_to_create ?? [])]);
        const shared = [...(b.files ?? []), ...(b.files_to_create ?? [])].filter(p => aPaths.has(p));
        if (shared.length) {
          problems.push(`subtasks ${a.id} and ${b.id} share ${[...new Set(shared)].join(', ')} in parallel_group ${group} (serialize one of them)`);
        }
      }
    }
  }
  result.valid = problems.length === 0;
  return result;
}

function readPlan(specPath: string): ({ subtasks: PlanSubtask[] } & Record<string, unknown>) | null {
  const plan = readJson<{ subtasks: PlanSubtask[] } & Record<string, unknown>>(path.join(specPath, 'plan.json'));
  return plan && Array.isArray(plan.subtasks) ? plan : null;
}

/** Validate the verdicts and, when valid, persist the updated plan.json under the plan-write lock. */
export async function validateAndApplyVerdicts(
  pipeline: ScopePipeline, deps: Pick<ScopeArbitrationDeps, 'planWriteLock'>, reports: ScopeReport[],
  plan: { subtasks: PlanSubtask[] } & Record<string, unknown>,
): Promise<ScopeApplyResult> {
  const result = validateScopeVerdicts(pipeline.specPath, plan, reports);
  if (!result.valid) {
    logToOutput(pipeline.specPath, `[SCOPE-REPLAN] Invalid scope verdicts: ${result.problems.join(', ')}\n`);
    return result;
  }
  const approvedCount = Object.values(result.approvals).reduce((n, l) => n + l.length, 0);
  const rejectedCount = Object.values(result.rejections).reduce((n, l) => n + l.length, 0);
  const planPath = path.join(pipeline.specPath, 'plan.json');
  const write = deps.planWriteLock.current.then(() => atomicWriteJson(planPath, result.plan));
  deps.planWriteLock.current = write.catch(() => undefined);
  await write;
  logToOutput(pipeline.specPath,
    `[SCOPE-REPLAN] Applied ${approvedCount} approval(s), ${rejectedCount} rejection(s), ${result.serializations} serialization(s)\n`);
  return result;
}

// ── Arbitration (budget + planner session) ────────────────────────────────

export type ScopeArbitrationResult =
  | { status: 'none'; actionStarted: false }
  | ScopeExhausted & { actionStarted: boolean }
  | { status: 'applied'; actionStarted: true; apply: ScopeApplyResult; reports: ScopeReport[] };

function buildHeader(deps: ScopeArbitrationDeps, pipeline: ScopePipeline, reports: ScopeReport[]): string {
  const lines = reports.map(r => `- ${deps.toAgentPath(scopeReportPath(pipeline.specPath, r.subtask_id))}`);
  return 'ℹ️ SCOPE ARBITRATION — coder sessions changed files outside their subtask `files`; their commits are held.\n' +
    'Scope reports:\n' + lines.join('\n') + '\n' +
    `Write your verdicts to ${deps.toAgentPath(path.join(pipeline.specPath, 'scope_verdicts.json'))}\n\n`;
}

async function runPlannerSession(deps: ScopeArbitrationDeps, pipeline: ScopePipeline, reports: ScopeReport[]): Promise<void> {
  const logFile = path.join(pipeline.specPath, 'output-scope-replan.log');
  const message = renderCommand('plan-revise',
    buildHeader(deps, pipeline, reports) +
    'This session writes only scope_verdicts.json — do not edit plan.json or any other file.');
  const sessionId = await processManager.createSession(deps.sessionOpts('planner', deps.projectRoot, pipeline.taskId, logFile));
  updateSessionMap(pipeline.specPath, 'scope-replan', sessionId);
  processManager.sendMessage(sessionId, message);
  try {
    await deps.waitForCompletion(sessionId);
  } finally {
    processManager.killSession(sessionId);
  }
}

function budgetCheck(
  pipeline: ScopePipeline, cfg: ScopeBudgetConfig, actionIds: number[],
): 'stall' | 'rounds' | null {
  const stall = Math.max(0, ...actionIds.map(id => pipeline.scopeStallCounts?.[id] ?? 0));
  return scopeBudgetExhausted({
    stall, rounds: pipeline.scopeReplanCount ?? 0, maxStall: cfg.maxScopeStall, maxRounds: cfg.maxScopeReplans,
  });
}

/**
 * One scope-arbitration action over all pending reports: assess progress, check the budgets,
 * run the planner session and apply its verdicts. An invalid verdict file costs every action
 * subtask one stall and, budget permitting, starts another session for the same reports.
 */
export async function runScopeArbitration(
  pipeline: ScopePipeline, deps: ScopeArbitrationDeps, cfg: ScopeBudgetConfig,
): Promise<ScopeArbitrationResult> {
  const specPath = pipeline.specPath;
  try { unlinkSync(path.join(specPath, 'scope_verdicts.json')); } catch { /* none */ }
  const reports = listPendingScopeReports(specPath);
  if (reports.length === 0) return { status: 'none', actionStarted: false };
  const plan = readPlan(specPath);
  if (!plan) throw new Error('Scope arbitration needs a readable plan.json');
  const actionIds = reports.map(r => r.subtask_id);

  pipeline.scopeStallCounts ??= {};
  pipeline.scopeRoundHistory ??= {};
  const records: Record<number, ScopeRoundRecord> = {};
  for (const r of reports) {
    const history = pipeline.scopeRoundHistory[r.subtask_id] ?? [];
    const record = buildScopeRoundRecord({
      subtaskId: r.subtask_id, scopeReplanCount: pipeline.scopeReplanCount ?? 0,
      unlistedFiles: r.unlisted.map(u => u.path), history,
    });
    const assessment = assessScopeProgress(history, record);
    const stall = assessment.progress ? 0 : (pipeline.scopeStallCounts[r.subtask_id] ?? 0) + 1;
    pipeline.scopeStallCounts[r.subtask_id] = stall;
    records[r.subtask_id] = record;
    logToOutput(specPath,
      `[SCOPE-BUDGET] subtask ${r.subtask_id} round ${record.round}/${cfg.maxScopeReplans}: ` +
      `${assessment.progress ? 'progress' : 'no progress'} (${assessment.reason}); stall ${stall}/${cfg.maxScopeStall}\n`);
  }

  let appended = false;
  let actionStarted = false;
  for (;;) {
    const exhausted = budgetCheck(pipeline, cfg, actionIds);
    if (exhausted) {
      deps.savePipelineState(pipeline);
      return {
        status: 'exhausted', budget: exhausted, subtaskIds: actionIds,
        files: reports.flatMap(r => r.unlisted.map(u => u.path)), actionStarted,
      };
    }
    pipeline.scopeReplanCount = (pipeline.scopeReplanCount ?? 0) + 1;
    if (!appended) {
      for (const id of actionIds) pipeline.scopeRoundHistory[id] = [...(pipeline.scopeRoundHistory[id] ?? []), records[id]];
      appended = true;
    }
    deps.savePipelineState(pipeline);
    actionStarted = true;

    await runPlannerSession(deps, pipeline, reports);
    const apply = await validateAndApplyVerdicts(pipeline, deps, reports, plan);
    if (apply.valid) {
      for (const id of actionIds) {
        records[id].approved = (apply.approvals[id] ?? []).map(p => scopeFileKey(id, p));
      }
      deps.savePipelineState(pipeline);
      return { status: 'applied', actionStarted: true, apply, reports };
    }
    for (const id of actionIds) pipeline.scopeStallCounts[id] = (pipeline.scopeStallCounts[id] ?? 0) + 1;
    deps.savePipelineState(pipeline);
  }
}

// ── Integration ───────────────────────────────────────────────────────────

async function sh(deps: Pick<ScopeArbitrationDeps, 'execGitCapture'>, cwd: string, args: string[]): Promise<string> {
  return (await deps.execGitCapture(args, cwd)).trim();
}

async function dropRejectedPaths(
  deps: ScopeArbitrationDeps, pipeline: ScopePipeline, report: ScopeReport, pre: string, rejected: ScopeRejection[],
): Promise<boolean> {
  const cwd = pipeline.worktreePath;
  let ok = true;
  for (const { path: p } of rejected) {
    try {
      if (report.held_ref) {
        let atPre = true;
        try { await sh(deps, cwd, ['cat-file', '-e', `${pre}:${p}`]); } catch { atPre = false; }
        if (atPre) await deps.execGit(['checkout', pre, '--', p], cwd);
        else if (await sh(deps, cwd, ['ls-files', '--', p])) await deps.execGit(['rm', '-f', '--', p], cwd);
      } else {
        const patch = await deps.execGitCapture(['diff', report.base, report.session_head, '--', p], cwd);
        if (!patch.trim()) continue;
        const patchFile = path.join(pipeline.specPath, `scope_drop-st${report.subtask_id}.patch`);
        writeFileSync(patchFile, patch.endsWith('\n') ? patch : patch + '\n');
        try { await deps.execGit(['apply', '-R', '--index', patchFile], cwd); } finally {
          try { unlinkSync(patchFile); } catch { /* best-effort */ }
        }
      }
    } catch (err) {
      ok = false;
      logToOutput(pipeline.specPath,
        `[SCOPE-DROP] Could not drop rejected changes to ${p} for subtask ${report.subtask_id}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  if (ok && await sh(deps, cwd, ['status', '--porcelain', '--untracked-files=no'])) {
    await deps.execGit(['commit', '--no-verify', '-m', `chore(scope): drop changes rejected by the planner for subtask ${report.subtask_id}`], cwd);
  }
  return ok;
}

export interface IntegrateResult {
  /** Subtasks completed without a re-run. */
  completed: number[];
  /** Set when deliverable verification hit its cap and the pipeline was already failed. */
  failed: boolean;
}

/**
 * Integrate each held subtask after its verdicts were applied: cherry-pick the held branch,
 * drop rejected paths, verify and complete it. A subtask left `completed: false` re-runs.
 */
export async function integrateHeldSubtasks(
  pipeline: ScopePipeline, deps: ScopeArbitrationDeps, applied: Extract<ScopeArbitrationResult, { status: 'applied' }>,
  completedIds: number[],
): Promise<IntegrateResult> {
  const specPath = pipeline.specPath;
  const cwd = pipeline.worktreePath;
  const logFile = path.join(specPath, 'output.log');
  const order = new Map(applied.apply.plan.subtasks.map((s, i) => [s.id, i]));
  const reports = [...applied.reports].sort((a, b) => (order.get(a.subtask_id) ?? 0) - (order.get(b.subtask_id) ?? 0));
  const result: IntegrateResult = { completed: [], failed: false };

  for (const report of reports) {
    const subtask = applied.apply.plan.subtasks.find(s => s.id === report.subtask_id);
    if (!subtask) continue;
    const id = subtask.id;
    const rejected = applied.apply.rejections[id] ?? [];
    const pre = await sh(deps, cwd, ['rev-parse', 'HEAD']);

    if (report.held_ref) {
      if (!(await deps.tryCherryPickWithRecovery(pipeline, logFile, report.held_ref, id))) {
        throw new WorktreeError(
          'Cherry-pick recovery exhausted — per-subtask branches have been preserved for manual recovery.',
          'CHERRY_PICK_RECOVERY_EXHAUSTED',
        );
      }
    }
    const dropped = await dropRejectedPaths(deps, pipeline, report, pre, rejected);
    if (rejected.length) appendScopeRejections(specPath, { [id]: rejected });

    let accept = dropped;
    if (accept && subtask.files_to_create?.length) {
      const verdict = await deps.verifySubtaskDeliverables(pipeline, subtask, cwd);
      if (verdict === 'failed') { result.failed = true; return result; }
      accept = verdict === 'ok';
    } else if (accept && (subtask.files ?? []).length > 0 && !subtask.verify_only) {
      let touched = false;
      try {
        const changed = (await sh(deps, cwd, ['diff', '--name-only', report.held_ref ? pre : report.base, 'HEAD'])).split('\n').filter(Boolean);
        touched = changed.some(f => subtask.files.includes(f));
      } catch { /* treated as untouched */ }
      let skipped = false;
      try { skipped = readFileSync(path.join(specPath, `output-st${id}.log`), 'utf-8').includes('[SKIPPED]'); } catch { /* no log */ }
      if (!touched && !(await deps.filesAlreadyChangedOnBranch(cwd, subtask.files)) && !skipped) {
        accept = false;
        logToOutput(specPath,
          `\n[VERIFY] Subtask ${id} ended without touching any of its assigned files — no edit was made:\n` +
          `[VERIFY] Assigned files: ${subtask.files.join(', ')}\n`);
        logToOutput(specPath, `[VERIFY] Subtask ${id} rejected — will re-run (see the specific reason logged above)\n`);
      }
    }

    if (accept) {
      if (!(await deps.completeSubtask(pipeline, subtask, cwd, pre, completedIds))) { result.failed = true; return result; }
      result.completed.push(id);
      logToOutput(specPath, `[SCOPE-REPLAN] Subtask ${id} integrated without a re-run\n`);
    }

    if (report.held_ref) {
      try { await deps.execGit(['branch', '-D', report.held_ref], deps.projectRoot); } catch { /* best-effort */ }
    }
    try { unlinkSync(scopeReportPath(specPath, id)); } catch { /* best-effort */ }
  }
  return result;
}

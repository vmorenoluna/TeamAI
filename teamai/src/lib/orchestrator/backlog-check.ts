/**
 * Backlog check: every agent session that can file tickets judges the whole
 * open board, and the orchestrator verifies that it did.
 *
 * Protocol, per unit (`spec`, `plan`, `st<N>` for an implement subtask, `qa`):
 *
 *  1. Before the session — prepareBacklogCheck() snapshots every open ticket
 *     except the task's own into `open_tickets-<unit>.json` (with a board
 *     fingerprint) and returns a prompt header pointing at it.
 *  2. The agent writes `backlog_check-<unit>.json`: one verdict per snapshot
 *     ticket (`unrelated` / `overlaps` / `supersedes` / `invalidates` /
 *     `update`), any new tickets, and — in the spec phase — a verdict on its
 *     own ticket (`self`: `proceed` / `reject`).
 *  3. After the session — runBacklogCheck() validates the file against the
 *     snapshot (every ticket exactly once, known verdicts, reasons present)
 *     and then, under the board lock (board-lock.ts), compares the live
 *     board with the snapshot's fingerprint. If tickets appeared meanwhile,
 *     nothing is written: the snapshot is refreshed and the agent is asked
 *     to judge the newcomers. Only a check made against the current board
 *     is applied. A missing or invalid file gets a short follow-up session
 *     naming the problems. After MAX_ROUNDS the caller fails the task.
 *
 * The lock is held only for the compare-and-apply, never across a session.
 *
 * Effects (applyCheck):
 *  - supersedes: the target is marked `supersededBy`; auto mode stops picking
 *    it and it is deleted when this task completes. Running targets get only
 *    a note — interrupting a live session is a human decision.
 *  - invalidates: the target depends on this task and gets a dated note; if
 *    it already has a spec, a spec revision is prepared so its next start or
 *    retry re-specs against the new context (helpers.hasPendingSpecRevision).
 *  - update: a dated note on the target.
 *  - new tickets: created as backlog tickets tagged `source: 'agent'` and
 *    `reportedBy`, so their own spec phase treats the description as an
 *    unverified claim. A title already on the board is not filed twice.
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { processManager, type AgentSession } from '../process-manager';
import { TaskStore, type Task } from '../task-store';
import { withBoardLock } from '../board-lock';
import { expandCommandIncludes } from '../command-templates';
import { prepareSpecRevisionArtifacts } from './review-actions';
import { hasPendingSpecRevision, restoreSpecRevisionFromDir, logToOutput } from './helpers';
import type { SessionOptsResult } from './types';

export const VERDICTS = ['unrelated', 'overlaps', 'supersedes', 'invalidates', 'update'] as const;
export type Verdict = typeof VERDICTS[number];
export const SELF_VERDICTS = ['proceed', 'reject'] as const;
export type SelfVerdict = typeof SELF_VERDICTS[number];

/** Follow-up sessions allowed per unit before the caller fails the task. */
export const MAX_ROUNDS = 3;

export interface SnapshotTicket {
  id: string;
  title: string;
  phase: string;
  description: string;
  /** Set when the ticket was filed by another task's agent. */
  reportedBy?: string;
}

export interface BoardSnapshot {
  fingerprint: string;
  takenAt: string;
  ownTaskId: string;
  tickets: SnapshotTicket[];
}

export interface CheckFile {
  tickets: Array<{ id: string; verdict: Verdict; reason: string }>;
  new_tickets?: Array<{ title: string; description: string }>;
  self?: { verdict: SelfVerdict; reason: string };
}

export const snapshotFile = (unit: string) => `open_tickets-${unit}.json`;
export const checkFile = (unit: string) => `backlog_check-${unit}.json`;
/** When the unit's first session started — survives wakeup re-entries so
 *  evidence written by a background job between sessions still counts. */
export const windowFile = (unit: string) => `backlog_window-${unit}.json`;
export const SPEC_DIR_PREFIX = '$TEAMAI_SPEC_DIR/';

const IDLE_PHASES = new Set(['backlog', 'failed']);
const NEW_TICKET_PREFIX = /^(Fix|Feat|Refactor|Docs): \S/;

/** Whether the project enforces the check (pipeline.json `backlogCheck`,
 *  default true — see PipelineConfig.backlogCheck). */
export function backlogCheckEnabled(getPipelineConfig?: () => { backlogCheck?: boolean }): boolean {
  try {
    return getPipelineConfig?.().backlogCheck === true;
  } catch {
    return false;
  }
}

// ── Snapshot ─────────────────────────────────────────────────────────────

/** Open tickets other than `ownTaskId`, in a stable order. */
export function openTickets(store: TaskStore, ownTaskId: string): SnapshotTicket[] {
  return store.getAll()
    .filter(t => t.id !== ownTaskId && t.phase !== 'done')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(t => ({
      id: t.id, title: t.title, phase: t.phase, description: t.description,
      ...(t.reportedBy ? { reportedBy: t.reportedBy } : {}),
    }));
}

/** Identity of the set of open tickets. Only additions and removals change
 *  it — a running task's phase or a note on a ticket does not invalidate a
 *  verdict, but a ticket the agent never saw does. */
export function boardFingerprint(tickets: Array<{ id: string }>): string {
  return createHash('sha256').update(tickets.map(t => t.id).sort().join('\n')).digest('hex').slice(0, 16);
}

function writeSnapshot(specPath: string, unit: string, store: TaskStore, ownTaskId: string): BoardSnapshot {
  const tickets = openTickets(store, ownTaskId);
  const snap: BoardSnapshot = {
    fingerprint: boardFingerprint(tickets), takenAt: new Date().toISOString(), ownTaskId, tickets,
  };
  writeFileSync(path.join(specPath, snapshotFile(unit)), JSON.stringify(snap, null, 2));
  return snap;
}

function readSnapshot(specPath: string, unit: string): BoardSnapshot | null {
  try {
    return JSON.parse(readFileSync(path.join(specPath, snapshotFile(unit)), 'utf-8')) as BoardSnapshot;
  } catch {
    return null;
  }
}

// ── Prompt header ────────────────────────────────────────────────────────

/**
 * Snapshot the board for `unit` and return the prompt header for its
 * session. Removes a check file left by an earlier attempt of the same unit,
 * so a stale verdict can never pass verification.
 */
export function prepareBacklogCheck(opts: {
  specPath: string;
  unit: string;
  store: TaskStore;
  ownTaskId: string;
  requireSelf: boolean;
  /** Implement subtasks: the check file is optional unless the session
   *  files/reports something or produces evidence matching these globs. */
  optionalUnlessEvidence?: string[];
}): string {
  const { specPath, unit, store, ownTaskId, requireSelf, optionalUnlessEvidence } = opts;
  try { unlinkSync(path.join(specPath, checkFile(unit))); } catch { /* none */ }
  const windowPath = path.join(specPath, windowFile(unit));
  if (!existsSync(windowPath)) writeFileSync(windowPath, JSON.stringify({ startedAt: Date.now() }));
  const snap = writeSnapshot(specPath, unit, store, ownTaskId);
  const own = store.getById(ownTaskId);
  let header =
    `ℹ️ BACKLOG CHECK — the open tickets for this session are in ` +
    `\`$TEAMAI_SPEC_DIR/${snapshotFile(unit)}\` (${snap.tickets.length} ticket(s)). `;
  if (optionalUnlessEvidence) {
    header +=
      `In this implement subtask the check file \`$TEAMAI_SPEC_DIR/${checkFile(unit)}\` is required only if ` +
      `you file or report anything about another ticket` +
      (optionalUnlessEvidence.length
        ? `, or if this session produces evidence files matching ${optionalUnlessEvidence.map(g => `\`${g}\``).join(', ')}`
        : '') +
      `. When you write it, it must cover every ticket in the snapshot, as described under **Backlog check**.\n`;
  } else {
    header +=
      `Before ending, write \`$TEAMAI_SPEC_DIR/${checkFile(unit)}\` as described under **Backlog check**. ` +
      `The orchestrator verifies it covers every ticket in the snapshot.\n`;
  }
  if (requireSelf) {
    header += `This session must also give a \`self\` verdict on its own ticket.\n`;
    if (own?.reportedBy) {
      const who = own.reportedByAgent ?? 'a pipeline agent';
      header +=
        `⚠️ This ticket was not written by an analyst: it was filed by ${who} while working on ` +
        `another task (${own.reportedBy}). Its description is that agent's unverified claim, made ` +
        `from the narrow view of its own work. Verifying it is your job: confirm the problem exists ` +
        `on the current code, is correctly diagnosed and is backed by current evidence before you ` +
        `spec it, and give your \`self\` verdict on that basis.\n`;
    }
  }
  return header + '\n';
}

// ── Evidence trigger (implement subtasks) ────────────────────────────────

/** Minimal glob → RegExp: `**` spans directories, `*` and `?` stay within a
 *  path segment. Paths are matched with forward slashes. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  const g = glob.replace(/\\/g, '/');
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') {
        i++;
        if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else { re += '.*'; }
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

function listFilesSince(dir: string, since: number, rel = ''): string[] {
  const out: string[] = [];
  let entries: import('fs').Dirent[];
  try { entries = readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFilesSince(dir, since, r));
    else {
      try { if (statSync(path.join(dir, r)).mtimeMs >= since) out.push(r); } catch { /* vanished */ }
    }
  }
  return out;
}

/** Start of the unit's evidence window (prepareBacklogCheck), or `fallback`. */
export function evidenceWindowStart(specPath: string, unit: string, fallback: number): number {
  try {
    const w = JSON.parse(readFileSync(path.join(specPath, windowFile(unit)), 'utf-8'));
    return typeof w.startedAt === 'number' ? w.startedAt : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Evidence files the unit produced: `changedFiles` (repo-relative paths the
 * session changed) matched against plain patterns, and files under
 * `specPath` modified since `since` matched against `$TEAMAI_SPEC_DIR/`
 * patterns. Returns the matching paths, spec-dir ones prefixed.
 */
export function evidenceProduced(opts: {
  patterns: string[];
  changedFiles: string[];
  specPath: string;
  since: number;
}): string[] {
  const repoPatterns = opts.patterns.filter(p => !p.startsWith(SPEC_DIR_PREFIX)).map(globToRegExp);
  const specPatterns = opts.patterns.filter(p => p.startsWith(SPEC_DIR_PREFIX))
    .map(p => globToRegExp(p.slice(SPEC_DIR_PREFIX.length)));
  const hits = opts.changedFiles
    .map(f => f.replace(/\\/g, '/'))
    .filter(f => repoPatterns.some(re => re.test(f)));
  if (specPatterns.length) {
    for (const f of listFilesSince(opts.specPath, opts.since)) {
      if (specPatterns.some(re => re.test(f))) hits.push(SPEC_DIR_PREFIX + f);
    }
  }
  return [...new Set(hits)];
}

// ── Validation ───────────────────────────────────────────────────────────

function readCheck(specPath: string, unit: string): { check: CheckFile | null; error?: string } {
  const p = path.join(specPath, checkFile(unit));
  if (!existsSync(p)) return { check: null, error: `${checkFile(unit)} was not written` };
  try {
    return { check: JSON.parse(readFileSync(p, 'utf-8')) as CheckFile };
  } catch (err) {
    return { check: null, error: `${checkFile(unit)} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Problems with `check` measured against `snap`; empty when valid. */
export function validateCheck(check: CheckFile, snap: BoardSnapshot, requireSelf: boolean): string[] {
  const problems: string[] = [];
  if (!Array.isArray(check.tickets)) return ['`tickets` must be an array with one entry per snapshot ticket'];
  const expected = new Set(snap.tickets.map(t => t.id));
  const seen = new Map<string, number>();
  for (const e of check.tickets) {
    const id = String(e?.id ?? '');
    seen.set(id, (seen.get(id) ?? 0) + 1);
    if (!expected.has(id)) { problems.push(`verdict for ${id || '(no id)'}, which is not in the snapshot`); continue; }
    if (!VERDICTS.includes(e.verdict)) problems.push(`${id}: unknown verdict "${e.verdict}" (use ${VERDICTS.join(', ')})`);
    else if (e.verdict !== 'unrelated' && !String(e.reason ?? '').trim()) problems.push(`${id}: verdict "${e.verdict}" needs a reason`);
  }
  for (const [id, n] of seen) if (n > 1 && expected.has(id)) problems.push(`${id}: ${n} verdicts, expected exactly one`);
  const missing = [...expected].filter(id => !seen.has(id));
  if (missing.length) problems.push(`no verdict for ${missing.length} ticket(s): ${missing.join(', ')}`);
  for (const [i, t] of (check.new_tickets ?? []).entries()) {
    if (!NEW_TICKET_PREFIX.test(String(t?.title ?? ''))) problems.push(`new_tickets[${i}]: title must start with Fix:, Feat:, Refactor: or Docs:`);
    if (!String(t?.description ?? '').trim()) problems.push(`new_tickets[${i}]: description with the evidence is required`);
  }
  if (requireSelf) {
    if (!check.self || !SELF_VERDICTS.includes(check.self.verdict)) problems.push('`self` verdict (proceed or reject) on this task\'s own ticket is required');
    else if (!String(check.self.reason ?? '').trim()) problems.push('`self` needs a reason');
  }
  return problems;
}

// ── Effects ──────────────────────────────────────────────────────────────

export interface AppliedEffects {
  created: string[];
  outcomes: Array<{ id: string; verdict: Verdict; result: 'applied' | 'note-only' | 'skipped'; detail?: string }>;
}

function appendNote(store: TaskStore, id: string, note: string): void {
  const t = store.getById(id);
  if (!t || t.description.includes(note)) return;
  const stamp = new Date().toISOString().slice(0, 10);
  store.update(id, { description: `${t.description}\n\n[${stamp}] ${note}` });
}

function prepareRespec(store: TaskStore, target: Task, note: string): boolean {
  const dir = store.getDirById(target.id);
  if (!existsSync(path.join(dir, 'spec.md')) || hasPendingSpecRevision(dir)) return false;
  prepareSpecRevisionArtifacts(dir, restoreSpecRevisionFromDir(dir) + 1,
    `# Spec revision: context changed\n\n${note}\n\n` +
    'Revise the spec so that every premise, measurement and baseline it relies on reflects the ' +
    'project as it is after that task. If the problem this ticket describes no longer exists, ' +
    'give a `reject` self verdict with the evidence instead of inventing work.\n',
    { clearStaleFeedback: true });
  // The revision number must come from the snapshots on the next run, not
  // from a pipeline state saved before this revision was prepared.
  try { unlinkSync(path.join(dir, '.pipeline_state.json')); } catch { /* absent */ }
  return true;
}

/** Apply a validated check on behalf of `source`. Caller holds the lock. */
export function applyCheck(store: TaskStore, check: CheckFile, source: Task, reporter = 'a pipeline agent'): AppliedEffects {
  const effects: AppliedEffects = { created: [], outcomes: [] };
  for (const e of check.tickets) {
    if (e.verdict === 'unrelated' || e.verdict === 'overlaps') continue;
    const target = store.getById(e.id);
    if (!target || target.phase === 'done') {
      effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'skipped', detail: 'no longer open' });
      continue;
    }
    const label = e.verdict === 'supersedes' ? 'Superseded by'
      : e.verdict === 'invalidates' ? 'Context changed by' : 'Update from';
    const action = e.verdict === 'invalidates'
      ? ' Re-derive this ticket\'s premise and evidence against that task\'s result before speccing; reject the ticket if the premise no longer holds.'
      : '';
    const note = `${label} "${source.title}" (${source.id}): ${e.reason}.${action}`;
    appendNote(store, target.id, note);

    if (e.verdict === 'update') { effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'applied' }); continue; }
    if (!IDLE_PHASES.has(target.phase)) {
      effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'note-only', detail: `target is running (${target.phase})` });
      continue;
    }
    if (e.verdict === 'supersedes') {
      if (source.supersededBy === target.id) {
        effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'skipped', detail: 'target already supersedes this task' });
        continue;
      }
      store.update(target.id, { supersededBy: source.id });
      effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'applied' });
      continue;
    }
    // invalidates
    const fresh = store.getById(target.id)!;
    const deps = fresh.dependencies ?? [];
    if (!deps.includes(source.id)) store.update(target.id, { dependencies: [...deps, source.id] });
    const respec = prepareRespec(store, fresh, note);
    effects.outcomes.push({ id: e.id, verdict: e.verdict, result: 'applied', detail: respec ? 'spec revision prepared' : undefined });
  }

  const titles = new Set(store.getAll().map(t => t.title));
  for (const t of check.new_tickets ?? []) {
    const title = t.title.trim();
    if (titles.has(title)) continue;
    const created = store.create(randomUUID(), title,
      `Reported by ${reporter} while working on "${source.title}" (${source.id}). ` +
      `Unverified: the analyst verifies this claim before speccing it.\n\n${t.description.trim()}`, 'agent');
    store.update(created.id, { reportedBy: source.id, reportedByAgent: reporter });
    titles.add(title);
    effects.created.push(created.id);
  }
  return effects;
}

// ── Compare-and-apply ────────────────────────────────────────────────────

export type CommitResult =
  | { status: 'applied'; effects: AppliedEffects; self?: CheckFile['self'] }
  | { status: 'invalid'; problems: string[] }
  | { status: 'stale'; added: string[] };

/**
 * Validate the unit's check and, if it was made against the current board,
 * apply it — atomically with respect to every other board writer.
 */
export function commitBacklogCheck(opts: {
  specPath: string;
  unit: string;
  store: TaskStore;
  ownTaskId: string;
  requireSelf: boolean;
  specsDir: string;
  /** Who files new tickets, e.g. "the coder agent (Subtask 3)". */
  reporter?: string;
}): CommitResult {
  const { specPath, unit, store, ownTaskId, requireSelf, specsDir, reporter } = opts;
  const snap = readSnapshot(specPath, unit);
  if (!snap) return { status: 'invalid', problems: [`snapshot ${snapshotFile(unit)} is missing`] };
  const { check, error } = readCheck(specPath, unit);
  if (!check) return { status: 'invalid', problems: [error!] };
  const problems = validateCheck(check, snap, requireSelf);
  if (problems.length) return { status: 'invalid', problems };

  return withBoardLock(specsDir, (): CommitResult => {
    const current = openTickets(store, ownTaskId);
    if (boardFingerprint(current) !== snap.fingerprint) {
      const known = new Set(snap.tickets.map(t => t.id));
      const added = current.filter(t => !known.has(t.id)).map(t => t.id);
      // Removed tickets don't matter (applyCheck skips them); only tickets
      // the agent never judged block the apply.
      if (added.length) return { status: 'stale', added };
    }
    const source = store.getById(ownTaskId);
    if (!source) return { status: 'invalid', problems: ['this task no longer exists'] };
    return { status: 'applied', effects: applyCheck(store, check, source, reporter), self: check.self };
  });
}

// ── Session loop ─────────────────────────────────────────────────────────

export interface BacklogCheckRun {
  specPath: string;
  unit: string;
  /** Human label for logs, e.g. "The spec phase", "Subtask 3". */
  unitLabel: string;
  taskId: string;
  role: AgentSession['role'];
  cwd: string;
  requireSelf: boolean;
  projectRoot: string;
  store?: TaskStore;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;
  /** Accept a missing check file as "nothing to report" (implement subtasks
   *  that produced no evidence). A file that exists is always verified. */
  optional?: boolean;
  /** Why the check is mandatory, quoted in the follow-up prompt. */
  requiredBecause?: string;
}

export type BacklogCheckOutcome =
  | { ok: true; self?: CheckFile['self']; effects: AppliedEffects }
  | { ok: false; problems: string[] };

const ROLE_NAMES: Record<string, string> = {
  analyst: 'the analyst agent', planner: 'the planner agent', coder: 'the coder agent', 'qa-reviewer': 'the QA reviewer agent',
};

function reporterLabel(run: BacklogCheckRun): string {
  return `${ROLE_NAMES[run.role] ?? `the ${run.role} agent`} (${run.unitLabel})`;
}

function followUpMessage(run: BacklogCheckRun, why: string): string {
  const contract = expandCommandIncludes('<!-- @include _shared/backlog-effects.md -->');
  return (
    `⚠️ BACKLOG CHECK INCOMPLETE — ${run.unitLabel} of this task ended without a backlog check the ` +
    `orchestrator could accept.\n\n${why}\n\n` +
    (run.requiredBecause ? `The check is required because ${run.requiredBecause}.\n\n` : '') +
    `Do only this: read \`$TEAMAI_SPEC_DIR/${snapshotFile(run.unit)}\` and write a complete ` +
    `\`$TEAMAI_SPEC_DIR/${checkFile(run.unit)}\`. Do not redo or change the task's own work.` +
    (run.requireSelf ? ' Include the `self` verdict on this task\'s own ticket.' : '') +
    `\n\n${contract}\n`
  );
}

function formatEffects(e: AppliedEffects, label: string): string {
  const lines = [`[BACKLOG-CHECK] ${label}: check accepted`];
  if (e.created.length) lines.push(`[BACKLOG-CHECK] ${label}: created ticket(s) ${e.created.join(', ')}`);
  for (const o of e.outcomes) lines.push(`[BACKLOG-CHECK] ${label}: ${o.verdict} ${o.id} → ${o.result}${o.detail ? ` (${o.detail})` : ''}`);
  return lines.join('\n') + '\n';
}

/**
 * Verify and apply the unit's backlog check, running follow-up sessions
 * (same role, same cwd) for a missing/invalid file or for tickets that
 * appeared since the snapshot. Returns `ok: false` after MAX_ROUNDS
 * follow-ups; the caller fails the task.
 */
export async function runBacklogCheck(run: BacklogCheckRun): Promise<BacklogCheckOutcome> {
  const store = run.store ?? new TaskStore(run.projectRoot);
  const specsDir = path.join(run.projectRoot, '.teamai');
  const endWindow = () => { try { unlinkSync(path.join(run.specPath, windowFile(run.unit))); } catch { /* none */ } };
  if (run.optional && !existsSync(path.join(run.specPath, checkFile(run.unit)))) {
    logToOutput(run.specPath, `[BACKLOG-CHECK] ${run.unitLabel}: nothing to report (no check file, no evidence produced)\n`);
    endWindow();
    return { ok: true, effects: { created: [], outcomes: [] } };
  }
  let lastProblems: string[] = [];
  for (let round = 0; ; round++) {
    const res = commitBacklogCheck({
      specPath: run.specPath, unit: run.unit, store, ownTaskId: run.taskId,
      requireSelf: run.requireSelf, specsDir, reporter: reporterLabel(run),
    });
    if (res.status === 'applied') {
      logToOutput(run.specPath, formatEffects(res.effects, run.unitLabel));
      endWindow();
      return { ok: true, self: res.self, effects: res.effects };
    }

    let why: string;
    if (res.status === 'invalid') {
      lastProblems = res.problems;
      why = `Problems:\n${res.problems.map(p => `- ${p}`).join('\n')}`;
    } else {
      // Refresh the snapshot so it includes the newcomers; the agent keeps
      // its existing verdicts and adds the missing ones.
      writeSnapshot(run.specPath, run.unit, store, run.taskId);
      lastProblems = [`tickets added since the snapshot were not judged: ${res.added.join(', ')}`];
      why = `New tickets appeared on the board while this session ran: ${res.added.join(', ')}. ` +
        `The snapshot has been refreshed. Add a verdict for each new ticket, keep your existing ` +
        `verdicts, and drop any entry in \`new_tickets\` that one of the new tickets already covers.`;
    }
    logToOutput(run.specPath, `[BACKLOG-CHECK] ${run.unitLabel}: not accepted (round ${round + 1}/${MAX_ROUNDS}) — ${lastProblems.join('; ')}\n`);
    if (round >= MAX_ROUNDS) { endWindow(); return { ok: false, problems: lastProblems }; }

    const logFile = path.join(run.specPath, `output-backlog-${run.unit}.log`);
    const sessionId = await processManager.createSession(run.sessionOpts(run.role, run.cwd, run.taskId, logFile));
    try {
      processManager.sendMessage(sessionId, followUpMessage(run, why));
      await run.waitForCompletion(sessionId);
    } finally {
      processManager.killSession(sessionId);
    }
  }
}

// ── Superseded lifecycle (auto mode, markTaskDone) ───────────────────────

/**
 * Is `task` held back by a live superseder? True while the superseding task
 * exists and is not done. A superseder that completed is handled by
 * finalizeSupersededTickets (the target gets deleted); one that was deleted
 * without completing releases the target.
 */
export function isHeldBySuperseder(task: Task, all: Task[], isCompleted: (id: string) => boolean): boolean {
  if (!task.supersededBy) return false;
  const sup = all.find(t => t.id === task.supersededBy);
  if (sup) return sup.phase !== 'done';
  return isCompleted(task.supersededBy);
}

/**
 * Delete idle tickets whose superseder has completed. Pass `completedId` to
 * finalize one superseder (markTaskDone); omit it to sweep every ticket
 * (auto-mode tick — covers completions that bypassed markTaskDone). Running
 * targets are never deleted. Returns the deleted ids.
 */
export function finalizeSupersededTickets(store: TaskStore, completedId?: string): string[] {
  const deleted: string[] = [];
  const all = store.getAll();
  for (const t of all) {
    if (!t.supersededBy || !IDLE_PHASES.has(t.phase)) continue;
    if (completedId !== undefined && t.supersededBy !== completedId) continue;
    const sup = all.find(s => s.id === t.supersededBy);
    const done = completedId !== undefined
      || (sup ? sup.phase === 'done' : store.isTaskCompleted(t.supersededBy));
    if (!done) continue;
    try {
      store.delete(t.id);
      deleted.push(t.id);
    } catch { /* already gone */ }
  }
  return deleted;
}

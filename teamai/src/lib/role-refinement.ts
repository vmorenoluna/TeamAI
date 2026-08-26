/**
 * Role Refinement Assistant — core lib (Phase 1: manual analysis + review UI).
 *
 * When a task fails, a headless *generic* session (no pipeline role persona —
 * it is instructed via the internal `role-refinement-analysis` command instead)
 * reads the failure artifacts and the five role files, then classifies
 * the root cause:
 *
 * - **Role-prompt gap** → emits diffable `edits[]` against `.claude/roles/*.md`
 *   (applied through the existing role-editor path, backed up for revert).
 * - **Contract gap** → `isRolePromptGap:false` + a self-contained, copyable
 *   `diagnosis` naming the `defaults/commands/` file that needs the upstream
 *   fix. NEVER a role edit — commands are force-synced from the shipped
 *   defaults at every startup, so a per-project command/role patch would be
 *   clobbered and would hide the gap from every other project.
 *
 * This module covers Phases 1–2: `mode` gating, the suggestion store, the
 * analysis engine (manual + auto triggers), recurrence detection, the shared
 * session seam, and apply/dismiss/revert. The watcher (auto-trigger on
 * recurrence) and sidebar badge live elsewhere; auto-apply is Phase 3.
 */
import { randomUUID, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { TaskStore } from './task-store';
import { writeRoleFile } from './role-files';
import { resolveProvider, providerToSessionOpts } from './providers';
import { processManager } from './process-manager';
import { waitForCompletion } from './orchestrator/rate-limit';
import { parseSessionLimitReset } from './orchestrator/helpers';
import { log as logInfo, warn as logWarn } from './logger';

// ── Types ──────────────────────────────────────────────────────────────────

export type RoleRefinementMode = 'off' | 'manual' | 'auto';
export type RoleRefinementStatus =
  | 'pending' | 'analyzing' | 'suggested' | 'no-gap'
  | 'applied' | 'dismissed' | 'superseded';
export type RoleRefinementTrigger = 'manual' | 'recurrence' | 'auto';
export type RefinementEditMode = 'append' | 'replace';
export type RefinementRiskClass = 'additive' | 'modifying';
export type RefinementConfidence = 'high' | 'medium' | 'low';

/** `.teamai/role-refinement.json` — feature config (mirrors auto-mode.json). */
export interface RoleRefinementConfig {
  /** 'off' hides the feature entirely; 'manual' is button-only (Phase 1 default); 'auto' is Phase 2. */
  mode: RoleRefinementMode;
  /** Model for the failure-analysis agent. Defaults to sonnet. */
  model: string;
  /** Phase 3 only — additive/low-risk edits only. */
  autoApply: boolean;
  /** Hard spend ceiling for the 'auto' trigger. */
  maxAutoAnalysesPerDay: number;
  /** Consecutive/aggregate failures before the auto trigger fires. */
  recurrenceThreshold: number;
}

export interface RoleRefinementEdit {
  /** Must be an existing file in the project's .claude/roles/. */
  roleFile: string;
  /** 'append' prefers additive fixes (current + "\n\n" + proposedContent). */
  mode: RefinementEditMode;
  rationale: string;
  /** Full new file body if 'replace'; block to append if 'append'. */
  proposedContent: string;
  /** Gates Phase-3 auto-apply. */
  riskClass: RefinementRiskClass;
}

export interface RoleRefinementBackup {
  roleFile: string;
  backupPath: string;
}

/** One suggestion record — `.teamai/role-refinements/<id>.json`. */
export interface RoleRefinementSuggestion {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: RoleRefinementStatus;
  trigger: RoleRefinementTrigger;
  /** Failures that motivated this record. */
  sourceTaskIds: string[];
  /** Dedupe key: sha256 of sorted FAIL-criterion names + role set. */
  signature: string;
  isRolePromptGap: boolean;
  /** True when the finding is a command (contract) gap, not a role gap. */
  contractGap: boolean;
  /** e.g. "implement.md" under defaults/commands/, set when contractGap. */
  contractFile: string | null;
  rootCause: string;
  confidence: RefinementConfidence;
  /** Always present — the 'why'. For contract gaps it must be self-contained
   *  and copyable so the user can paste it as a prompt to an agent working on
   *  the TeamAI repo itself. */
  diagnosis: string;
  edits: RoleRefinementEdit[];
  appliedAt: string | null;
  appliedBy: 'human' | 'auto' | null;
  backups: RoleRefinementBackup[];
}

/** Session seam for analyzeFailure — injectable so tests can fake the agent.
 *  The session is `role: 'general'`: it must NOT carry a pipeline role persona
 *  (those describe how to develop the project) — the internal
 *  `role-refinement-analysis` command supplies its instructions instead. */
export interface RoleRefinementAnalyzeDeps {
  createSession: (opts: {
    taskId: string;
    role: 'general';
    cwd: string;
    projectRoot: string;
    permissionMode: 'bypassPermissions';
    model?: string;
    env?: Record<string, string>;
  }) => Promise<string>;
  sendMessage: (sessionId: string, content: string) => void;
  waitForCompletion: (sessionId: string) => Promise<void>;
  killSession: (sessionId: string) => void;
}

/**
 * Real session recipe for analyzeFailure — the insights-session pattern with
 * the project's configured role-refinement model (Settings → Role Refinements,
 * default sonnet) and rate-limit-aware completion. Shared by the manual server
 * action and the Phase-2 recurrence watcher so both entry points run the
 * identical session lifecycle.
 */
export function makeRoleRefinementAnalyzeDeps(): RoleRefinementAnalyzeDeps {
  return {
    createSession: (opts: Parameters<typeof processManager.createSession>[0]) =>
      processManager.createSession(opts),
    sendMessage: (sessionId: string, content: string) => processManager.sendMessage(sessionId, content),
    waitForCompletion: (sessionId: string) => waitForCompletion(sessionId, { parseSessionLimitReset }),
    killSession: (sessionId: string) => processManager.killSession(sessionId),
  };
}

// ── Config ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROLE_REFINEMENT_CONFIG: RoleRefinementConfig = {
  mode: 'manual',
  model: 'claude-sonnet-4-6',
  autoApply: false,
  maxAutoAnalysesPerDay: 5,
  recurrenceThreshold: 2,
};

/** §7 retry-loop guard — how many refinement-retries before auto-analysis escalates. */
export const REFINEMENT_RETRY_LOOP_CAP = 2;

/** Phase-3 auto-apply size cap — an appended block may be at most this many characters. */
export const MAX_AUTO_APPEND_CHARS = 1500;

const CONFIG_FILE = 'role-refinement.json';
const REFINEMENTS_DIR = 'role-refinements';

function isMode(v: unknown): v is RoleRefinementMode {
  return v === 'off' || v === 'manual' || v === 'auto';
}

/** Read `.teamai/role-refinement.json`, merging over defaults. Missing/invalid → defaults. */
export function getRoleRefinementConfig(projectRoot: string): RoleRefinementConfig {
  try {
    const p = join(projectRoot, '.teamai', CONFIG_FILE);
    if (!existsSync(p)) return { ...DEFAULT_ROLE_REFINEMENT_CONFIG };
    const cfg = JSON.parse(readFileSync(p, 'utf-8'));
    return {
      ...DEFAULT_ROLE_REFINEMENT_CONFIG,
      ...cfg,
      mode: isMode(cfg.mode) ? cfg.mode : DEFAULT_ROLE_REFINEMENT_CONFIG.mode,
    };
  } catch {
    return { ...DEFAULT_ROLE_REFINEMENT_CONFIG };
  }
}

/** Persist the feature config (atomic temp-then-rename). */
export function setRoleRefinementConfig(projectRoot: string, cfg: RoleRefinementConfig): void {
  const dir = join(projectRoot, '.teamai');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, CONFIG_FILE);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  try {
    renameSync(tmp, p);
  } catch {
    // Windows can briefly hold a lock — fall back to a direct write.
    try { writeFileSync(p, JSON.stringify(cfg, null, 2)); } catch { /* best-effort */ }
  }
}

// ── Suggestion store ───────────────────────────────────────────────────────

function refinementsDir(projectRoot: string): string {
  return join(projectRoot, '.teamai', REFINEMENTS_DIR);
}

function suggestionPath(projectRoot: string, id: string): string {
  return join(refinementsDir(projectRoot), `${id}.json`);
}

/** Atomic temp-then-rename write of a suggestion record. */
function writeSuggestionRecord(projectRoot: string, record: RoleRefinementSuggestion): void {
  const dir = refinementsDir(projectRoot);
  mkdirSync(dir, { recursive: true });
  const p = suggestionPath(projectRoot, record.id);
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2));
  try {
    renameSync(tmp, p);
  } catch {
    try { writeFileSync(p, JSON.stringify(record, null, 2)); } catch { /* best-effort */ }
  }
}

export function getSuggestion(projectRoot: string, id: string): RoleRefinementSuggestion | null {
  try {
    const p = suggestionPath(projectRoot, id);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as RoleRefinementSuggestion;
  } catch {
    return null;
  }
}

/** List all suggestion records, newest first. Excludes the raw `.analysis.json` payloads. */
export function listSuggestions(projectRoot: string): RoleRefinementSuggestion[] {
  const dir = refinementsDir(projectRoot);
  if (!existsSync(dir)) return [];
  const records: RoleRefinementSuggestion[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json') || f.includes('.analysis.')) continue;
    try {
      const record = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as RoleRefinementSuggestion;
      if (record && record.id) records.push(record);
    } catch { /* unreadable — skip */ }
  }
  return records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function suggestionsForTask(projectRoot: string, taskId: string): RoleRefinementSuggestion[] {
  return listSuggestions(projectRoot).filter(s => s.sourceTaskIds.includes(taskId));
}

/**
 * Write a suggestion record, superseding any pending/analyzing/suggested record
 * with the same signature (never stack duplicates — the anti-churn guardrail).
 * The record being written is excluded by id.
 */
export function writeSuggestion(projectRoot: string, record: RoleRefinementSuggestion): void {
  const existing = listSuggestions(projectRoot);
  for (const s of existing) {
    if (s.id === record.id) continue;
    if (s.signature && s.signature === record.signature && (s.status === 'pending' || s.status === 'analyzing' || s.status === 'suggested')) {
      updateSuggestion(projectRoot, s.id, { status: 'superseded' });
    }
  }
  writeSuggestionRecord(projectRoot, record);
}

/** Patch an existing record (merges fields, bumps updatedAt). */
export function updateSuggestion(
  projectRoot: string,
  id: string,
  patch: Partial<Omit<RoleRefinementSuggestion, 'id' | 'createdAt'>>,
): RoleRefinementSuggestion | null {
  const record = getSuggestion(projectRoot, id);
  if (!record) return null;
  const updated: RoleRefinementSuggestion = {
    ...record,
    ...patch,
    id: record.id,
    createdAt: record.createdAt,
    updatedAt: new Date().toISOString(),
  };
  writeSuggestionRecord(projectRoot, updated);
  return updated;
}

// ── Signature ──────────────────────────────────────────────────────────────

/**
 * Dedupe key for a failure: sha256 over the sorted FAIL-criterion names in the
 * task's qa_report.json (falling back to the task id when the report is absent)
 * plus the fixed role-file set. Two failures with identical FAIL signatures are
 * treated as the same root cause.
 */
export function buildFailureSignature(taskDir: string, fallbackSeed: string): string {
  let criteria: string[] = [];
  const reportPath = join(taskDir, 'qa_report.json');
  if (existsSync(reportPath)) {
    try {
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (Array.isArray(report.criteria)) {
        criteria = report.criteria
          .filter((c: { status?: string }) => c?.status === 'FAIL')
          .map((c: { name?: unknown }) => String(c?.name ?? ''));
      }
    } catch { /* fall through to the seed */ }
  }
  const payload = `criteria:${[...new Set(criteria)].sort().join('|')}||seed:${fallbackSeed}`;
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

// ── Recurrence detection (Phase 2 — auto-trigger) ─────────────────────────

/** Rolling window (7 days) for the cross-task recurrence signal. */
export const RECURRENCE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecurrenceDetection {
  hit: boolean;
  /** Task ids in the recurrence cluster — the target plus any cross-task siblings. */
  cluster: string[];
  /** Dedupe signature for the cluster (union of FAIL criteria, sorted + hashed). */
  signature: string;
}

/** Read the sorted, deduped set of FAIL-criterion names from a QA report file. */
function readFailCriteria(reportPath: string): Set<string> {
  try {
    if (!existsSync(reportPath)) return new Set();
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    if (!Array.isArray(report.criteria)) return new Set();
    const names = report.criteria
      .filter((c: { status?: string }) => c?.status === 'FAIL')
      .map((c: { criterion?: unknown; name?: unknown }) => String(c?.criterion ?? c?.name ?? '').trim())
      .filter(Boolean);
    return new Set(names);
  } catch {
    return new Set();
  }
}

/** sha256 signature over a FAIL-criterion set + a seed (see buildFailureSignature). */
function hashFailCriteria(criteria: Set<string>, seed: string): string {
  const payload = `criteria:${[...criteria].sort().join('|')}||seed:${seed}`;
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * Phase-2 recurrence detection (§2.3 / §6.1). Fires on any of:
 *  1. **Persisted criterion** — the target's current `qa_report.json` shares a
 *     FAIL-criterion name with a previous cycle's snapshot
 *     (`qa_report_before_bounce.json` / `qa_report_before_failed.json`), i.e.
 *     the same criterion has persisted-failed across ≥2 consecutive QA cycles.
 *  2. **Repeated task failure** — the target has reached `failed` ≥
 *     `recurrenceThreshold` times (the events.jsonl count includes the current
 *     failure, so ≥2 means at least one prior failure).
 *  3. **Cross-task cluster** — ≥2 distinct tasks failed with overlapping
 *     FAIL-criterion names within the rolling window.
 *
 * The returned `signature` is built over the whole cluster's union of FAIL
 * criteria, seeded with the sorted cluster ids so the same cluster yields the
 * same signature no matter which member task triggers the detection.
 */
export function detectRecurrence(projectRoot: string, taskId: string): RecurrenceDetection {
  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task) return { hit: false, cluster: [], signature: '' };

  const threshold = getRoleRefinementConfig(projectRoot).recurrenceThreshold;
  const taskDir = taskStore.getDirById(taskId);
  const currentFail = readFailCriteria(join(taskDir, 'qa_report.json'));

  // 1. Persisted-criterion signal: same FAIL name in a previous cycle's snapshot.
  let persistedCriterion = false;
  if (currentFail.size > 0) {
    for (const snap of ['qa_report_before_bounce.json', 'qa_report_before_failed.json']) {
      const prev = readFailCriteria(join(taskDir, snap));
      if (prev.size > 0 && [...currentFail].some(name => prev.has(name))) {
        persistedCriterion = true;
        break;
      }
    }
  }

  // 2. Repeated-failure signal: failed transitions ≥ threshold.
  const failedCount = taskStore.getEvents(taskId).filter(e => e.phase === 'failed').length;

  // 3. Cross-task signal: other tasks with a recent failed transition sharing a
  //    FAIL-criterion name with the target (cluster members).
  const cluster = [taskId];
  const clusterFail = new Set<string>(currentFail);
  const now = Date.now();
  for (const t of taskStore.getAll()) {
    if (t.id === taskId) continue;
    const lastFailed = [...taskStore.getEvents(t.id)].reverse().find(e => e.phase === 'failed');
    if (!lastFailed) continue;
    if (now - new Date(lastFailed.timestamp).getTime() > RECURRENCE_WINDOW_MS) continue;
    const failNames = readFailCriteria(join(taskStore.getDirById(t.id), 'qa_report.json'));
    if (failNames.size === 0) continue;
    if (currentFail.size > 0 && [...currentFail].some(name => failNames.has(name))) {
      cluster.push(t.id);
      for (const name of failNames) clusterFail.add(name);
    }
  }

  const hit = persistedCriterion || failedCount >= threshold || cluster.length >= 2;
  return {
    hit,
    cluster,
    signature: hit ? hashFailCriteria(clusterFail, [...cluster].sort().join(',')) : '',
  };
}

/**
 * Count auto-triggered analyses started today — the `maxAutoAnalysesPerDay`
 * spend ceiling for the 'auto' trigger. Records are counted by local calendar
 * day of `createdAt` (the analysis is stamped synchronously at start).
 */
export function countAutoAnalysesToday(projectRoot: string, now: Date = new Date()): number {
  const sameLocalDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  return listSuggestions(projectRoot)
    .filter(s => s.trigger === 'auto' && sameLocalDay(new Date(s.createdAt), now)).length;
}

// ── Analyzer ───────────────────────────────────────────────────────────────

const ROLE_FILES = ['analyst', 'planner', 'coder', 'qa-reviewer', 'merger'];

const ANALYSIS_ARTIFACTS = [
  'qa_report.json',
  'qa_report_before_bounce.json',
  'qa_report_before_failed.json',
  'completion_summary.md',
  'qa_feedback.md',
  'plan.json',
  'events.jsonl',
  'output-st1.log',
  'output-qa.log',
  'output-plan.log',
];

/** Name of the internal analysis command synced to `.claude/commands/`. */
export const ROLE_REFINEMENT_ANALYSIS_COMMAND = 'role-refinement-analysis';

/** Build the analysis session's first message — a slash-command invocation.
 *  The classification instructions + JSON output contract live in the internal
 *  command template `defaults/commands/role-refinement-analysis.md` (force-synced
 *  into `.claude/commands/`, not user-customisable); `$ARGUMENTS` carries the
 *  dynamic paths. `taskDirs` holds every task in the recurrence cluster (just one
 *  for a manual trigger), so on the auto path the agent sees the sibling failures
 *  too. */
export function buildAnalysisCommand(projectRoot: string, taskDirs: string[], analysisPath: string): string {
  const artifactPaths: string[] = [];
  for (const taskDir of taskDirs) {
    for (const f of ANALYSIS_ARTIFACTS) {
      if (existsSync(join(taskDir, f))) artifactPaths.push(join(taskDir, f));
    }
  }

  const rolePaths = ROLE_FILES
    .map(r => join(projectRoot, '.claude', 'roles', `${r}.md`))
    .filter(p => existsSync(p));

  return [
    `/${ROLE_REFINEMENT_ANALYSIS_COMMAND}`,
    '',
    `OUTPUT_FILE: ${analysisPath}`,
    'FAILURE_ARTIFACTS:',
    ...artifactPaths.map(p => `- ${p}`),
    '',
    'ROLE_FILES:',
    ...rolePaths.map(p => `- ${p}`),
  ].join('\n');
}

/** Defensively parse the analyst's `.analysis.json` output into a suggestion-shaped object. */
export function parseAnalysisOutput(raw: string): {
  isRolePromptGap: boolean;
  contractGap: boolean;
  contractFile: string | null;
  rootCause: string;
  confidence: RefinementConfidence;
  diagnosis: string;
  edits: RoleRefinementEdit[];
} {
  try {
    const o = JSON.parse(raw);
    const edits: RoleRefinementEdit[] = Array.isArray(o.edits)
      ? o.edits
          .filter((e: RoleRefinementEdit) => e && typeof e.roleFile === 'string' && typeof e.proposedContent === 'string')
          .map((e: RoleRefinementEdit) => ({
            roleFile: e.roleFile,
            mode: e.mode === 'replace' ? 'replace' : 'append',
            rationale: typeof e.rationale === 'string' ? e.rationale : '',
            proposedContent: e.proposedContent,
            riskClass: e.riskClass === 'modifying' ? 'modifying' : 'additive',
          }))
      : [];
    return {
      isRolePromptGap: o.isRolePromptGap === true,
      contractGap: o.contractGap === true,
      contractFile: typeof o.contractFile === 'string' ? o.contractFile : null,
      rootCause: typeof o.rootCause === 'string' ? o.rootCause : '',
      confidence: o.confidence === 'high' || o.confidence === 'low' ? o.confidence : 'medium',
      diagnosis: typeof o.diagnosis === 'string' ? o.diagnosis : '',
      edits,
    };
  } catch (err) {
    return {
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: '',
      confidence: 'low',
      diagnosis: `The failure analysis did not return a readable result${err instanceof Error ? ` (${err.message})` : ''}. ` +
        'No role-prompt gap was identified — review the task artifacts manually.',
      edits: [],
    };
  }
}

/**
 * Run a failure post-mortem (manual trigger + Phase-2 auto trigger).
 *
 * 1. Writes a `analyzing` record + stamps the task.
 * 2. Spawns a headless generic session (insights-session recipe, no pipeline
 *    role persona) with the project's configured role-refinement model
 *    (default sonnet), instructed via the internal
 *    `role-refinement-analysis` command.
 * 3. The agent writes `<id>.analysis.json`; we parse it defensively.
 * 4. Records `suggested` or `no-gap`, stamps the task, emits a
 *    `refinement-update` processManager event so open task panels refresh.
 *
 * `sourceTaskIds` (the recurrence cluster) becomes the record's motivating
 * task list and drives which task dirs the analyst reads. `taskId` remains the
 * primary task (stamped for the inline card, kept first in sourceTaskIds).
 *
 * Returns the suggestion id. Never throws on session/parse failure — the
 * record is marked `no-gap` with the failure in the diagnosis instead.
 */
export async function analyzeFailure(
  projectRoot: string,
  taskId: string,
  trigger: RoleRefinementTrigger,
  deps: RoleRefinementAnalyzeDeps,
  signatureOverride?: string,
  sourceTaskIds?: string[],
): Promise<string> {
  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const taskDir = taskStore.getDirById(taskId);

  const sourceTasks = sourceTaskIds && sourceTaskIds.length > 0 ? sourceTaskIds : [taskId];

  const id = randomUUID();
  const record: RoleRefinementSuggestion = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'analyzing',
    trigger,
    sourceTaskIds: sourceTasks,
    // The watcher passes the cluster signature (whole cluster's FAIL criteria)
    // so a recurrence record dedupes against itself across triggers; the manual
    // path defaults to this task's own signature.
    signature: signatureOverride ?? buildFailureSignature(taskDir, taskId),
    isRolePromptGap: true,
    contractGap: false,
    contractFile: null,
    rootCause: '',
    confidence: 'low',
    diagnosis: 'Analysis in progress.',
    edits: [],
    appliedAt: null,
    appliedBy: null,
    backups: [],
  };
  writeSuggestion(projectRoot, record);
  // A fresh analysis is the user (or watcher) taking action — clear any
  // prior retry-loop escalation so the banner doesn't linger across attempts.
  taskStore.update(taskId, { refinementStatus: 'analyzing', refinementSuggestionId: id, refinementEscalated: false });

  const analysisPath = join(refinementsDir(projectRoot), `${id}.analysis.json`);
  const command = buildAnalysisCommand(projectRoot, sourceTasks.map(tid => taskStore.getDirById(tid)), analysisPath);

  let sessionId: string | undefined;
  try {
    // The analysis agent is NOT a pipeline role: `general` gets no role persona
    // injected, and the model comes from the Role Refinements settings (default
    // sonnet), not the `analyst` role's provider override. Provider/env still
    // come from the project's providers config default.
    const config = getRoleRefinementConfig(projectRoot);
    const providerCfg = { ...resolveProvider(projectRoot, 'general'), model: config.model };
    const providerOpts = providerToSessionOpts(providerCfg);
    sessionId = await deps.createSession({
      taskId: `role-refinement::${taskId}`,
      role: 'general',
      cwd: projectRoot,
      projectRoot,
      ...providerOpts,
      permissionMode: 'bypassPermissions',
    });
    deps.sendMessage(sessionId, command);
    await deps.waitForCompletion(sessionId);
  } catch (err) {
    logWarn('role-refinement', `Analysis session failed for task ${taskId}`, err);
    updateSuggestion(projectRoot, id, {
      status: 'no-gap',
      isRolePromptGap: false,
      rootCause: '',
      confidence: 'low',
      diagnosis: `The failure analysis session did not complete${err instanceof Error ? ` (${err.message})` : ''}. ` +
        'No role-prompt gap was identified — review the task artifacts manually.',
    });
    taskStore.update(taskId, { refinementStatus: 'no-gap' });
    emitRefinementUpdate(projectRoot, taskId);
    return id;
  } finally {
    if (sessionId) {
      try { deps.killSession(sessionId); } catch { /* best-effort */ }
    }
  }

  let output: ReturnType<typeof parseAnalysisOutput>;
  try {
    output = parseAnalysisOutput(readFileSync(analysisPath, 'utf-8'));
  } catch (err) {
    logWarn('role-refinement', `Failed to read analysis output for task ${taskId}`, err);
    output = {
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: '',
      confidence: 'low',
      diagnosis: `The analysis did not write a readable result file${err instanceof Error ? ` (${err.message})` : ''}. ` +
        'No role-prompt gap was identified — review the task artifacts manually.',
      edits: [],
    };
  }

  const status: RoleRefinementStatus = output.isRolePromptGap ? 'suggested' : 'no-gap';
  updateSuggestion(projectRoot, id, {
    status,
    isRolePromptGap: output.isRolePromptGap,
    contractGap: output.contractGap,
    contractFile: output.contractGap ? output.contractFile : null,
    rootCause: output.rootCause,
    confidence: output.confidence,
    diagnosis: output.diagnosis,
    edits: output.edits,
  });
  taskStore.update(taskId, { refinementStatus: status === 'suggested' ? 'suggested' : 'no-gap' });
  emitRefinementUpdate(projectRoot, taskId);
  logInfo('role-refinement', `Analysis ${id} for task ${taskId} → ${status}`);
  return id;
}

/** Broadcast a refinement-update so open task panels / the /task page refresh. */
function emitRefinementUpdate(projectRoot: string, taskId: string): void {
  try {
    processManager.emit('refinement-update', { taskId, projectRoot });
  } catch { /* best-effort — the record is persisted regardless */ }
}

// ── Apply / dismiss / revert ───────────────────────────────────────────────

const ROLE_DIR = join('.claude', 'roles');

/** Backups dir for a suggestion — `.teamai/role-refinements/backups/`. */
function backupsDir(projectRoot: string): string {
  return join(refinementsDir(projectRoot), 'backups');
}

/**
 * Apply a suggested refinement: snapshot each edited role file, then write via
 * the shared `writeRoleFile` (same validation as the Role Editor). `overrides`
 * lets the user's hand-edited text replace an edit's proposedContent.
 * `appliedBy` distinguishes human review applies from Phase-3 auto-apply
 * (which is gated on `isAutoApplyEligible` by the watcher).
 */
export function applyRefinement(
  projectRoot: string,
  id: string,
  overrides?: Record<string, string>,
  appliedBy: 'human' | 'auto' = 'human',
): RoleRefinementSuggestion {
  const record = getSuggestion(projectRoot, id);
  if (!record) throw new Error(`Suggestion ${id} not found`);
  if (record.status !== 'suggested') {
    throw new Error(`Suggestion ${id} is in status "${record.status}", not "suggested"`);
  }
  if (record.edits.length === 0) {
    throw new Error('This suggestion has no role edits to apply');
  }

  const rolesDir = join(projectRoot, ROLE_DIR);
  mkdirSync(backupsDir(projectRoot), { recursive: true });

  const backups: RoleRefinementBackup[] = [];
  for (const edit of record.edits) {
    const content = overrides?.[edit.roleFile] ?? edit.proposedContent;
    const target = join(rolesDir, edit.roleFile);

    // Snapshot the current file for one-click revert.
    let current = '';
    try {
      if (existsSync(target)) current = readFileSync(target, 'utf-8');
    } catch { /* missing file — treat as empty */ }

    const backupPath = join(backupsDir(projectRoot), `${record.id}-${edit.roleFile}`);
    try {
      writeFileSync(backupPath, current, 'utf-8');
    } catch { /* best-effort — a failed backup is surfaced below via warn */ }

    const next = edit.mode === 'append'
      ? (current.trim() ? `${current.trim()}\n\n${content.trim()}\n` : `${content.trim()}\n`)
      : content;

    try {
      writeRoleFile(rolesDir, edit.roleFile, next);
    } catch (err) {
      logWarn('role-refinement', `Failed to write role file ${edit.roleFile}`, err);
      throw err;
    }
    backups.push({ roleFile: edit.roleFile, backupPath });
  }

  const now = new Date().toISOString();
  return updateSuggestion(projectRoot, id, {
    status: 'applied',
    appliedAt: now,
    appliedBy,
    backups,
  })!;
}

// ── Phase-3 auto-apply eligibility ─────────────────────────────────────────

export interface AutoApplyEligibility {
  eligible: boolean;
  /** Human-readable reason when ineligible — logged by the watcher. */
  reason?: string;
}

/**
 * Phase-3 auto-apply gate (§2.5 / §2.6 / §7). Auto-apply is restricted to
 * additive, size-capped, high-confidence edits only — anything else still
 * requires human review. `config.autoApply` and the pipeline auto-runner are
 * checked by the watcher (compounded opt-ins); this function checks the
 * record itself plus the retry-loop guard.
 */
export function isAutoApplyEligible(
  record: RoleRefinementSuggestion,
  task: { refinementRetryCount?: number },
): AutoApplyEligibility {
  if (record.trigger !== 'auto') return { eligible: false, reason: `trigger is ${record.trigger}, not auto` };
  if (record.status !== 'suggested') return { eligible: false, reason: `record is ${record.status}, not suggested` };
  if (!record.isRolePromptGap) return { eligible: false, reason: 'not a role-prompt gap' };
  if (record.confidence !== 'high') return { eligible: false, reason: `confidence is ${record.confidence}, not high` };
  if (record.edits.length === 0) return { eligible: false, reason: 'no edits to apply' };
  for (const edit of record.edits) {
    if (edit.mode !== 'append' || edit.riskClass !== 'additive') {
      return { eligible: false, reason: `${edit.roleFile} is ${edit.mode}/${edit.riskClass}, not additive append` };
    }
    if (edit.proposedContent.trim().length > MAX_AUTO_APPEND_CHARS) {
      return { eligible: false, reason: `${edit.roleFile} append exceeds ${MAX_AUTO_APPEND_CHARS} chars` };
    }
  }
  if ((task.refinementRetryCount ?? 0) >= REFINEMENT_RETRY_LOOP_CAP) {
    return { eligible: false, reason: 'retry-loop cap reached' };
  }
  return { eligible: true };
}

/** Dismiss a suggestion (no role edits are made). */
export function dismissRefinement(projectRoot: string, id: string): RoleRefinementSuggestion | null {
  const record = getSuggestion(projectRoot, id);
  if (!record) return null;
  if (record.status === 'applied' || record.status === 'dismissed' || record.status === 'superseded') return record;
  return updateSuggestion(projectRoot, id, { status: 'dismissed' });
}

/** Revert an applied refinement: restore every backup, then mark dismissed. */
export function revertRefinement(projectRoot: string, id: string): RoleRefinementSuggestion | null {
  const record = getSuggestion(projectRoot, id);
  if (!record) return null;
  if (record.status !== 'applied') throw new Error(`Suggestion ${id} is not applied — nothing to revert`);
  for (const backup of record.backups) {
    try {
      if (existsSync(backup.backupPath)) {
        writeRoleFile(join(projectRoot, ROLE_DIR), backup.roleFile, readFileSync(backup.backupPath, 'utf-8'));
      }
    } catch (err) {
      logWarn('role-refinement', `Failed to restore ${backup.roleFile} from backup`, err);
      throw err;
    }
  }
  return updateSuggestion(projectRoot, id, { status: 'dismissed', appliedAt: null });
}

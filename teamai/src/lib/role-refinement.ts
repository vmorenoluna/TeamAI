/**
 * Role Refinement Assistant — core lib (Phase 1: manual analysis + review UI).
 *
 * When a task fails, a headless `analyst` session (the insights side-channel
 * recipe) reads the failure artifacts and the five role files, then classifies
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
 * This module is Phase 1 scope: `mode` gating, the suggestion store, the
 * manual-only analysis engine, and apply/dismiss/revert. The watcher
 * (auto-trigger on recurrence), sidebar badge, and auto-apply are Phase 2/3.
 */
import { randomUUID, createHash } from 'crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { join } from 'path';
import { TaskStore } from './task-store';
import { writeRoleFile } from './role-files';
import { resolveProvider, providerToSessionOpts } from './providers';
import { processManager } from './process-manager';
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

/** Session seam for analyzeFailure — injectable so tests can fake the agent. */
export interface RoleRefinementAnalyzeDeps {
  createSession: (opts: {
    taskId: string;
    role: 'analyst';
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

// ── Config ─────────────────────────────────────────────────────────────────

export const DEFAULT_ROLE_REFINEMENT_CONFIG: RoleRefinementConfig = {
  mode: 'manual',
  autoApply: false,
  maxAutoAnalysesPerDay: 5,
  recurrenceThreshold: 2,
};

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

// ── Analyzer ───────────────────────────────────────────────────────────────

const ROLE_FILES = ['analyst', 'planner', 'coder', 'qa-reviewer', 'merger'];

/** Build the analysis prompt (§6.3) — inputs handed as paths, never pre-summarized. */
export function buildAnalysisPrompt(projectRoot: string, taskDir: string, analysisPath: string): string {
  const artifactPaths = [
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
  ].filter(f => existsSync(join(taskDir, f))).map(f => join(taskDir, f));

  const rolePaths = ROLE_FILES
    .map(r => join(projectRoot, '.claude', 'roles', `${r}.md`))
    .filter(p => existsSync(p));

  return [
    'You are diagnosing why a TeamAI pipeline ticket failed repeatedly. Classify the root cause as exactly one of:',
    '(a) a **role-prompt gap** — a missing or misworded *project-specific* persona/convention in `.claude/roles/*.md`;',
    '(b) an **orchestration-contract gap** — an undocumented TeamAI mechanism or environment rule that belongs in `.claude/commands/*.md`, not a role;',
    '(c) genuine task difficulty, a spec problem, or a code bug.',
    'Only (a) produces role edits. (b) is an upstream command change, never a role edit.',
    '',
    'Known contract-gap classes that are NOT role edits:',
    '- an undocumented orchestrator mechanism (e.g. the `subtask_wakeup-st<id>.json` schema and its detach/nohup requirement, worktree/port discipline),',
    '- a `.gitignore` / `git add -f` trap when committing verification evidence,',
    '- an interactive-only tool that no-ops in headless sessions.',
    '',
    'A role gap is project-specific persona/convention: missing house style, a repo-specific convention, or a misworded project convention that misleads the agent.',
    '',
    'Read these failure artifacts as **paths** (do not rely on summaries):',
    ...artifactPaths.map(p => `- ${p}`),
    '',
    'Read the current role files as **paths**:',
    ...rolePaths.map(p => `- ${p}`),
    '',
    `Write a single JSON object to ${analysisPath} with exactly this shape:`,
    '{',
    '  "isRolePromptGap": boolean,',
    '  "contractGap": boolean,',
    '  "contractFile": string|null,',
    '  "rootCause": string,',
    '  "confidence": "high"|"medium"|"low",',
    '  "diagnosis": string,',
    '  "edits": [ { "roleFile": string, "mode": "append"|"replace", "rationale": string, "proposedContent": string, "riskClass": "additive"|"modifying" } ]',
    '}',
    '',
    'Rules:',
    '- Prefer mode:"append" for additive fixes (a short block appended to the role file).',
    '- If it is NOT a role-prompt gap, set isRolePromptGap:false, leave edits empty, and explain the real cause in diagnosis.',
    '- If it IS a contract gap, also set contractGap:true and contractFile to the affected file under defaults/commands/ (e.g. "implement.md"), say so explicitly in diagnosis, and name the file that needs the upstream fix — never emit a role edit for it.',
    '- Write diagnosis as a self-contained, copyable prompt the user can paste into a TeamAI-repo agent.',
    'Write ONLY the JSON file. Do not write anything else.',
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
 * Run a failure post-mortem (Phase 1: manual trigger only).
 *
 * 1. Writes a `analyzing` record + stamps the task.
 * 2. Spawns a headless `analyst` session (insights-session recipe) with the
 *    project's configured analyst model.
 * 3. The agent writes `<id>.analysis.json`; we parse it defensively.
 * 4. Records `suggested` or `no-gap`, stamps the task, emits a
 *    `refinement-update` processManager event so open task panels refresh.
 *
 * Returns the suggestion id. Never throws on session/parse failure — the
 * record is marked `no-gap` with the failure in the diagnosis instead.
 */
export async function analyzeFailure(
  projectRoot: string,
  taskId: string,
  trigger: RoleRefinementTrigger,
  deps: RoleRefinementAnalyzeDeps,
): Promise<string> {
  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  const taskDir = taskStore.getDirById(taskId);

  const id = randomUUID();
  const record: RoleRefinementSuggestion = {
    id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'analyzing',
    trigger,
    sourceTaskIds: [taskId],
    signature: buildFailureSignature(taskDir, taskId),
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
  taskStore.update(taskId, { refinementStatus: 'analyzing', refinementSuggestionId: id });

  const analysisPath = join(refinementsDir(projectRoot), `${id}.analysis.json`);
  const prompt = buildAnalysisPrompt(projectRoot, taskDir, analysisPath);

  let sessionId: string | undefined;
  try {
    const providerCfg = resolveProvider(projectRoot, 'analyst');
    const providerOpts = providerToSessionOpts(providerCfg);
    sessionId = await deps.createSession({
      taskId: `role-refinement::${taskId}`,
      role: 'analyst',
      cwd: projectRoot,
      projectRoot,
      ...providerOpts,
      permissionMode: 'bypassPermissions',
    });
    deps.sendMessage(sessionId, prompt);
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
 */
export function applyRefinement(
  projectRoot: string,
  id: string,
  overrides?: Record<string, string>,
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
    appliedBy: 'human',
    backups,
  })!;
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

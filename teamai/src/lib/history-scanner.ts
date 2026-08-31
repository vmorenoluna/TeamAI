/**
 * DONE-ticket history scanner (§3f).
 *
 * Local ticket folders are deleted on completion, so DONE tickets are
 * reconstructed from git/PR history — never from disk:
 *
 *   Source A — commit trailers (cheap, local, eager):
 *     git log --grep '^Task: ' --format='%h|%ad|%s|%b'
 *     Pure local git over commit metadata; runs once at project load and
 *     the result is cached in memory as Map<slug, DoneTicketFromHistory>.
 *
 *   Source B — merged-PR bodies (slower, remote, rate-limited, lazy):
 *     gh pr list --search 'Task: in:body' --state merged
 *     GitHub Search API is capped at 30 req/min, so Source B is fetched
 *     lazily (page-by-page) and only for PR-strategy tickets. A
 *     'local-merge' task never has a PR, so Source A is the only way to
 *     recover it.
 *
 *   Merge by Task: slug, preferring Source A (it has the real commit
 *   hash/date). Sorted newest-first. On task completion, the fresh ticket
 *   is synthesized from the data the pipeline already built (commit
 *   message / PR body) and prepended — no re-query.
 *
 * All of this is active only when recordHistoryInGit is on: the toggle
 * being off means the user doesn't want ticket history kept at all, so no
 * reconstruction is attempted.
 */
import { execFileSync } from 'child_process';
import { getToolPath } from './tool-checker';
import { warn as logWarn, info as logInfo } from './logger';

/** Lightweight DONE card rebuilt from trailers + PR body. */
export interface DoneTicketFromHistory {
  /** Commit subject minus "type: " prefix, or plain PR title. */
  title: string;
  /** Commit or PR body (2-4 lines). */
  summary: string;
  /** Task: trailer value (= slug). */
  slug: string;
  /** Task-ID: trailer. */
  taskId?: string;
  /** QA: trailer line. */
  qaResult?: string;
  /** Phases: trailer — absent when includePhasesTrailer was off. */
  phaseChain?: string;
  /** Commit / author / mergedAt date. */
  completedAt: Date;
  /** From Source B — absent for a 'local-merge' task. */
  prUrl?: string;
  /** Which index source(s) matched. */
  source: 'commit' | 'pr-body' | 'both';
  /** On-demand from PR body, cached after first fetch. */
  specContent?: string;
}

/** Strip the "type: " prefix from a Conventional-Commits subject. */
function stripTypePrefix(subject: string): string {
  const m = /^(feat|fix|refactor|chore|docs|test|style|perf|build|ci):\s*/i.exec(subject.trim());
  return m ? subject.trim().slice(m[0].length) : subject.trim();
}

/** Parse the trailer block out of a commit body or PR body. */
function parseTrailers(body: string): Partial<Record<'Task' | 'Task-ID' | 'QA' | 'Phases', string>> {
  const out: Partial<Record<'Task' | 'Task-ID' | 'QA' | 'Phases', string>> = {};
  for (const line of body.split('\n')) {
    const m = /^(Task|Task-ID|QA|Phases):\s*(.+)$/i.exec(line.trim());
    if (m) {
      const key = m[1] as 'Task' | 'Task-ID' | 'QA' | 'Phases';
      if (!out[key]) out[key] = m[2].trim();
    }
  }
  return out;
}

/** Extract the `## Specification` section from a PR body (on-demand spec fetch). */
export function extractSpecification(prBody: string): string | null {
  const idx = prBody.indexOf('## Specification');
  if (idx < 0) return null;
  const rest = prBody.slice(idx + '## Specification'.length);
  // Section ends at the next '---' separator or the trailer block.
  const endIdx = rest.search(/\n---\n|\nTask:\s/i);
  const spec = (endIdx >= 0 ? rest.slice(0, endIdx) : rest).trim();
  return spec || null;
}

export interface HistoryScannerDeps {
  /** Project root (the target codebase's git repo). */
  projectRoot: string;
  /** Whether recordHistoryInGit is on — when false, no scanning happens. */
  recordHistoryInGit: boolean;
}

export class HistoryScanner {
  private readonly _projectRoot: string;
  private readonly _enabled: boolean;
  /** slug → ticket, merged from both sources, sorted on read. */
  private _cache = new Map<string, DoneTicketFromHistory>();

  constructor(deps: HistoryScannerDeps) {
    this._projectRoot = deps.projectRoot;
    this._enabled = deps.recordHistoryInGit;
  }

  /** Whether history reconstruction is active (recordHistoryInGit on). */
  get isEnabled(): boolean { return this._enabled; }

  /**
   * Source A — local commit trailers. One git log pass over commit
   * metadata; typically well under a second even on large repos.
   */
  scanCommitTrailers(): Map<string, DoneTicketFromHistory> {
    const result = new Map<string, DoneTicketFromHistory>();
    if (!this._enabled) return result;

    let raw: string;
    try {
      raw = execFileSync('git', [
        'log', '--grep', '^Task: ',
        '--format=%h%x1f%ad%x1f%s%x1f%b%x1e',
        '--date=iso',
      ], { cwd: this._projectRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024, timeout: 15_000 });
    } catch (err) {
      logWarn('history', 'scanCommitTrailers: git log failed (not a git repo?)', err);
      return result;
    }

    for (const record of raw.split('\u001e')) {
      const parts = record.split('\u001f').map(s => s.trim());
      if (parts.length < 4 || !parts[0]) continue;
      const [, dateStr, subject, body] = parts;
      const trailers = parseTrailers(body);
      const slug = trailers.Task;
      if (!slug) continue;

      const ticket: DoneTicketFromHistory = {
        title: stripTypePrefix(subject),
        summary: summarize(body),
        slug,
        taskId: trailers['Task-ID'],
        qaResult: trailers.QA,
        phaseChain: trailers.Phases,
        completedAt: parseDate(dateStr) || new Date(0),
        source: 'commit',
      };
      // Later commits for the same slug (retries) win — they are newer.
      result.set(slug, ticket);
    }
    return result;
  }

  /**
   * Source B — merged-PR bodies via gh. Paginated and rate-limited
   * (30 req/min on the Search API), so callers should invoke this lazily
   * (page-by-page) rather than eagerly at load.
   */
  /** Number of tickets returned by the most recent Source B page (for hasMore). */
  lastPrPageCount = 0;

  scanMergedPrBodies(limit = 10): Map<string, DoneTicketFromHistory> {
    const result = new Map<string, DoneTicketFromHistory>();
    this.lastPrPageCount = 0;
    if (!this._enabled) return result;

    let raw: string;
    try {
      raw = execFileSync(getToolPath('gh'), [
        'pr', 'list',
        '--state', 'merged',
        '--search', 'Task: in:body',
        '--limit', String(limit),
        '--json', 'url,body,mergedAt,title',
      ], { cwd: this._projectRoot, encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
    } catch (err) {
      logWarn('history', 'scanMergedPrBodies: gh pr list failed (offline / not github?)', err);
      return result;
    }

    let items: Array<{ url?: string; body?: string; mergedAt?: string; title?: string }>;
    try {
      const parsed: unknown = JSON.parse(raw);
      items = Array.isArray(parsed)
        ? (parsed as Array<{ url?: string; body?: string; mergedAt?: string; title?: string }>)
        : [];
    } catch (err) {
      logWarn('history', 'scanMergedPrBodies: failed to parse gh output', err);
      return result;
    }

    this.lastPrPageCount = items.length;

    for (const pr of items) {
      const body = pr.body || '';
      const trailers = parseTrailers(body);
      const slug = trailers.Task;
      if (!slug) continue;
      result.set(slug, {
        title: pr.title ? stripTypePrefix(pr.title) : stripTypePrefix(firstLine(body)),
        summary: summarize(body),
        slug,
        taskId: trailers['Task-ID'],
        qaResult: trailers.QA,
        phaseChain: trailers.Phases,
        completedAt: parseDate(pr.mergedAt) || new Date(0),
        prUrl: pr.url,
        source: 'pr-body',
      });
    }
    return result;
  }

  /**
   * Full scan: Source A (eager) merged with Source B (lazy, first page).
   * Merged by slug, preferring Source A. Returns tickets sorted
   * newest-first and primes the in-memory cache.
   */
  rescan(): DoneTicketFromHistory[] {
    this._cache = new Map();
    if (!this._enabled) return [];

    const commits = this.scanCommitTrailers();
    for (const [slug, ticket] of commits) this._cache.set(slug, ticket);

    const prs = this.scanMergedPrBodies();
    for (const [slug, prTicket] of prs) {
      const existing = this._cache.get(slug);
      if (existing) {
        // Both sources matched — enrich the commit ticket with the PR URL.
        existing.prUrl = prTicket.prUrl ?? existing.prUrl;
        existing.source = 'both';
      } else {
        this._cache.set(slug, prTicket);
      }
    }

    logInfo('history', `rescan: ${this._cache.size} DONE tickets reconstructed from history`);
    return this.sorted();
  }

  /** Cached tickets, newest-first. */
  sorted(): DoneTicketFromHistory[] {
    return [...this._cache.values()].sort(
      (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
    );
  }

  /** Cached lookup by slug. */
  getBySlug(slug: string): DoneTicketFromHistory | undefined {
    return this._cache.get(slug);
  }

  /**
   * Incremental append on completion (§3f): synthesize the fresh ticket
   * directly from data the pipeline already built (trailer lines + body)
   * and prepend it — it's the newest entry by construction, so no re-query.
   */
  appendOnCompletion(input: {
    slug: string;
    taskId: string;
    title: string;
    taskType?: string | null;
    summary: string;
    trailerLines: string[];
    prUrl?: string;
  }): DoneTicketFromHistory {
    const trailers = parseTrailers(input.trailerLines.join('\n'));
    const ticket: DoneTicketFromHistory = {
      title: input.title,
      summary: input.summary,
      slug: input.slug,
      taskId: input.taskId,
      qaResult: trailers.QA,
      phaseChain: trailers.Phases,
      completedAt: new Date(),
      prUrl: input.prUrl,
      source: input.prUrl ? 'both' : 'commit',
    };
    this._cache.set(input.slug, ticket);
    return ticket;
  }

  /**
   * Ticket detail — full spec, fetched on open (never preloaded).
   * For PR-strategy tickets: fetch the PR body and extract
   * `## Specification`. Cached after first fetch per slug.
   * For 'local-merge' tickets (no prUrl): falls back to the commit body's
   * short summary — there is no PR to fetch a full spec from.
   */
  async getSpecContent(slug: string): Promise<string | null> {
    const ticket = this._cache.get(slug);
    if (!ticket) return null;
    if (ticket.specContent) return ticket.specContent;
    if (!ticket.prUrl) return ticket.summary; // local-merge fallback

    try {
      const raw = execFileSync(getToolPath('gh'), [
        'pr', 'view', ticket.prUrl, '--json', 'body',
      ], { cwd: this._projectRoot, encoding: 'utf-8', timeout: 15_000 });
      const body = (JSON.parse(raw) as { body?: string }).body ?? '';
      ticket.specContent = extractSpecification(body) ?? ticket.summary;
    } catch (err) {
      logWarn('history', `getSpecContent: failed to fetch PR body for ${slug}`, err);
      ticket.specContent = ticket.summary;
    }
    return ticket.specContent;
  }
}


// ── helpers ───────────────────────────────────────────────────────────────

function summarize(body: string, maxLines = 4): string {
  const lines = body
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(Task|Task-ID|QA|Phases|Reviewed-by):/i.test(l) && !l.startsWith('#'));
  return lines.slice(0, maxLines).join('\n');
}

function firstLine(body: string): string {
  return body.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) ?? '';
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

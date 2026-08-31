'use server';

import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import {
  HistoryScanner,
  type DoneTicketFromHistory,
} from '@/lib/history-scanner';
import {
  mergedDoneTickets,
  clearSessionTickets,
} from '@/lib/history-session';

export interface DoneHistoryPayload {
  /** Whether reconstruction is active (recordHistoryInGit on). */
  enabled: boolean;
  /** DONE tickets, newest-first. */
  tickets: DoneTicketFromHistory[];
  /** True when Source B (merged PRs) may have more pages available. */
  hasMore: boolean;
}

/**
 * HistoryScanner.rescan() runs two synchronous, blocking execFileSync calls
 * — a local `git log` and a live network call to `gh pr list` against
 * GitHub's rate-limited Search API. getDoneHistory() runs on every
 * navigation to '/' (the most-visited route), and execFileSync blocks
 * Node's entire single-threaded event loop for its duration — so without
 * caching, rapid repeated navigations (real users clicking around, or an
 * E2E suite hammering the page) serialize behind that live network call and
 * stall *every other concurrent request*, not just the history fetch.
 *
 * Caches the HistoryScanner *instance* (not just its ticket list) so a
 * cache hit also reuses the instance's already-populated internal
 * slug→ticket map — getDoneTicketSpec()'s lookup, and its own per-slug
 * specContent cache, depend on that map being populated, which a fresh
 * scanner instance never is until rescan() runs on it.
 */
const SCAN_CACHE_TTL_MS = 30_000;
interface ScanCacheEntry {
  at: number;
  recordHistoryInGit: boolean;
  scanner: HistoryScanner;
  tickets: DoneTicketFromHistory[];
}
const scanCache = new Map<string, ScanCacheEntry>();

function getCachedScan(projectPath: string, recordHistoryInGit: boolean): ScanCacheEntry {
  const cached = scanCache.get(projectPath);
  if (
    cached &&
    cached.recordHistoryInGit === recordHistoryInGit &&
    Date.now() - cached.at < SCAN_CACHE_TTL_MS
  ) {
    return cached;
  }
  const scanner = new HistoryScanner({ projectRoot: projectPath, recordHistoryInGit });
  const tickets = scanner.isEnabled ? scanner.rescan() : [];
  const entry: ScanCacheEntry = { at: Date.now(), recordHistoryInGit, scanner, tickets };
  scanCache.set(projectPath, entry);
  return entry;
}

/**
 * Reconstruct DONE tickets from git/PR history (§3f).
 *
 * Source A (local commit trailers) runs eagerly; Source B (merged PRs) loads
 * its first page lazily. Session-appended tickets (from this session's
 * completions) are merged on top of the scan results.
 */
export async function getDoneHistory(): Promise<DoneHistoryPayload> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  const { scanner, tickets } = getCachedScan(projectPath, config.recordHistoryInGit);
  if (!scanner.isEnabled) return { enabled: false, tickets: [], hasMore: false };
  return {
    enabled: true,
    tickets: mergedDoneTickets(projectPath, tickets),
    hasMore: true,
  };
}

/** Manual "rescan history" escape hatch (force-pushes, manual git surgery) — bypasses the cache. */
export async function rescanDoneHistory(): Promise<DoneHistoryPayload> {
  const projectPath = await getActiveProjectPath();
  scanCache.delete(projectPath);
  return getDoneHistory();
}

/** Load the next page of merged-PR (Source B) tickets. */
export async function loadMoreDoneHistory(
  page: number,
  pageSize = 10,
): Promise<DoneHistoryPayload> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  const scanner = new HistoryScanner({
    projectRoot: projectPath,
    recordHistoryInGit: config.recordHistoryInGit,
  });
  if (!scanner.isEnabled) return { enabled: false, tickets: [], hasMore: false };

  const pageTickets = scanner.scanMergedPrBodies(page * pageSize);
  return {
    enabled: true,
    tickets: mergedDoneTickets(projectPath, [...pageTickets.values()]),
    hasMore: scanner.lastPrPageCount >= pageSize,
  };
}

/**
 * Ticket detail — full spec fetched on open (never preloaded).
 * Falls back to the commit summary for local-merge tickets (no PR).
 */
export async function getDoneTicketSpec(
  slug: string,
): Promise<{ spec: string | null }> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  const { scanner } = getCachedScan(projectPath, config.recordHistoryInGit);
  if (!scanner.isEnabled) return { spec: null };
  return { spec: await scanner.getSpecContent(slug) };
}

/** Clear a project's session-only DONE tickets (used on project switch). */
export async function resetDoneHistorySession(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  if (projectPath) clearSessionTickets(projectPath);
}

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
 * Reconstruct DONE tickets from git/PR history (§3f).
 *
 * Source A (local commit trailers) runs eagerly; Source B (merged PRs) loads
 * its first page lazily. Session-appended tickets (from this session's
 * completions) are merged on top of the scan results.
 */
export async function getDoneHistory(): Promise<DoneHistoryPayload> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  const scanner = new HistoryScanner({
    projectRoot: projectPath,
    recordHistoryInGit: config.recordHistoryInGit,
  });
  if (!scanner.isEnabled) return { enabled: false, tickets: [], hasMore: false };
  const scanned = scanner.rescan();
  return {
    enabled: true,
    tickets: mergedDoneTickets(projectPath, scanned),
    hasMore: true,
  };
}

/** Manual "rescan history" escape hatch (force-pushes, manual git surgery). */
export async function rescanDoneHistory(): Promise<DoneHistoryPayload> {
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
  const scanner = new HistoryScanner({
    projectRoot: projectPath,
    recordHistoryInGit: config.recordHistoryInGit,
  });
  if (!scanner.isEnabled) return { spec: null };
  scanner.rescan();
  return { spec: await scanner.getSpecContent(slug) };
}

/** Clear a project's session-only DONE tickets (used on project switch). */
export async function resetDoneHistorySession(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  if (projectPath) clearSessionTickets(projectPath);
}

import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import {
  HistoryScanner,
  type DoneTicketFromHistory,
} from '@/lib/history-scanner';

export interface DoneHistoryPayload {
  /** Whether reconstruction is active (recordHistoryInGit on). */
  enabled: boolean;
  /** DONE tickets, newest-first. */
  tickets: DoneTicketFromHistory[];
}

/**
 * Reconstruct DONE tickets from git/PR history (§3f).
 *
 * Source A (local commit trailers) runs eagerly; Source B (merged-PR
 * bodies) loads its first page lazily — the DONE column merges this with
 * Source A and fetches further pages on scroll. When recordHistoryInGit
 * is off, returns enabled:false with no tickets and no lookups are made.
 */
export async function getDoneHistory(): Promise<DoneHistoryPayload> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  const scanner = new HistoryScanner({
    projectRoot: projectPath,
    recordHistoryInGit: config.recordHistoryInGit,
  });
  if (!scanner.isEnabled) return { enabled: false, tickets: [] };
  return { enabled: true, tickets: scanner.rescan() };
}

/** Manual "rescan history" escape hatch (force-pushes, manual git surgery). */
export async function rescanDoneHistory(): Promise<DoneHistoryPayload> {
  return getDoneHistory();
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

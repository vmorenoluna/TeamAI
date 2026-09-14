import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';

import type { DoneTicketFromHistory } from './history-scanner';

/**
 * Durable UI metadata for completed tasks that were processed by Auto mode.
 *
 * Task workspaces are deleted after completion and the completed task itself
 * is reconstructed from git history. This file intentionally lives directly
 * under `.teamai/`, outside the per-task workspace, so the mutable
 * "reviewed" acknowledgement survives task cleanup and server restarts.
 */
export interface AutoReviewRecord {
  taskId: string;
  slug: string;
  autoProcessedAt: string;
  autoReviewedAt?: string;
}

type AutoReviewFile = Record<string, AutoReviewRecord>;

function filePath(projectRoot: string): string {
  return join(projectRoot, '.teamai', 'auto-review.json');
}

function readRecords(projectRoot: string): AutoReviewFile {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath(projectRoot), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as AutoReviewFile : {};
  } catch {
    return {};
  }
}

function writeRecords(projectRoot: string, records: AutoReviewFile): void {
  const dir = join(projectRoot, '.teamai');
  mkdirSync(dir, { recursive: true });
  const target = filePath(projectRoot);
  const temp = target + '.tmp';
  writeFileSync(temp, JSON.stringify(records, null, 2));
  renameSync(temp, target);
}

/** Record that Auto mode completed a task, preserving any prior acknowledgement. */
export function recordAutoProcessed(projectRoot: string, taskId: string, slug: string): void {
  const records = readRecords(projectRoot);
  const existing = records[slug];
  records[slug] = {
    taskId,
    slug,
    autoProcessedAt: existing?.autoProcessedAt ?? new Date().toISOString(),
    ...(existing?.autoReviewedAt ? { autoReviewedAt: existing.autoReviewedAt } : {}),
  };
  writeRecords(projectRoot, records);
}

/** Find auto-mode metadata by either the history slug or the original task ID. */
export function getAutoReviewStatus(
  projectRoot: string,
  taskIdOrSlug: string,
): AutoReviewRecord | null {
  const records = readRecords(projectRoot);
  const direct = records[taskIdOrSlug];
  if (direct) return direct;
  return Object.values(records).find(record => record.taskId === taskIdOrSlug) ?? null;
}

/** Mark a completed auto-processed task as manually reviewed. */
export function markAutoReviewed(projectRoot: string, taskIdOrSlug: string): AutoReviewRecord | null {
  const records = readRecords(projectRoot);
  const match = records[taskIdOrSlug]
    ? taskIdOrSlug
    : Object.keys(records).find(slug => records[slug]?.taskId === taskIdOrSlug);
  if (!match || !records[match]) return null;

  records[match] = {
    ...records[match],
    autoReviewedAt: new Date().toISOString(),
  };
  writeRecords(projectRoot, records);
  return records[match];
}

/** Add durable auto-review flags to a history-reconstructed DONE ticket. */
export function withAutoReviewStatus(
  projectRoot: string,
  ticket: DoneTicketFromHistory,
): DoneTicketFromHistory {
  const record = getAutoReviewStatus(projectRoot, ticket.taskId ?? ticket.slug);
  if (!record) return ticket;
  return {
    ...ticket,
    autoProcessed: true,
    autoReviewed: !!record.autoReviewedAt,
  };
}

/** Test helper for isolated projects. */
export function clearAutoReviewRecords(projectRoot: string): void {
  const target = filePath(projectRoot);
  if (existsSync(target)) {
    // Keep this helper deliberately best-effort; tests and teardown should not
    // fail because a record was already removed.
    try { writeFileSync(target, '{}'); } catch { /* best-effort */ }
  }
}

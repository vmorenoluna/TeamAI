// @vitest-environment node

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  recordAutoProcessed,
  getAutoReviewStatus,
  markAutoReviewed,
  withAutoReviewStatus,
} from '@/lib/auto-review-store';
import type { DoneTicketFromHistory } from '@/lib/history-scanner';
import { createTestProject } from '../utils/test-project';

describe('auto-review-store', () => {
  it('keeps auto-completion metadata after the task workspace is removed', () => {
    const { root, clean } = createTestProject();
    try {
      recordAutoProcessed(root, 'task-1', 'completed-task');

      expect(existsSync(join(root, '.teamai', 'auto-review.json'))).toBe(true);
      expect(getAutoReviewStatus(root, 'task-1')).toMatchObject({
        taskId: 'task-1',
        slug: 'completed-task',
      });
      expect(JSON.parse(readFileSync(join(root, '.teamai', 'auto-review.json'), 'utf-8'))).toHaveProperty('completed-task');
    } finally {
      clean();
    }
  });

  it('marks a history ticket as reviewed by task ID without task.json', () => {
    const { root, clean } = createTestProject();
    try {
      recordAutoProcessed(root, 'task-2', 'another-task');

      expect(markAutoReviewed(root, 'task-2')).toMatchObject({
        taskId: 'task-2',
        slug: 'another-task',
        autoReviewedAt: expect.any(String),
      });

      const ticket: DoneTicketFromHistory = {
        title: 'Another task',
        summary: 'Completed.',
        slug: 'another-task',
        taskId: 'task-2',
        completedAt: new Date(),
        source: 'commit',
      };
      expect(withAutoReviewStatus(root, ticket)).toMatchObject({
        autoProcessed: true,
        autoReviewed: true,
      });
    } finally {
      clean();
    }
  });

  it('does not add flags to ordinary history tickets', () => {
    const { root, clean } = createTestProject();
    try {
      const ticket: DoneTicketFromHistory = {
        title: 'Ordinary task',
        summary: 'Completed.',
        slug: 'ordinary-task',
        completedAt: new Date(),
        source: 'commit',
      };
      expect(withAutoReviewStatus(root, ticket)).toEqual(ticket);
    } finally {
      clean();
    }
  });
});

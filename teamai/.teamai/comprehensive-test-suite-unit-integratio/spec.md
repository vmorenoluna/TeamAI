# Spec: Comprehensive test suite — unit, integration, and E2E tests

## Overview
Add Vitest for unit/integration tests covering core library modules (ProcessManager, TaskStore, utils) and Playwright for E2E tests covering the Kanban board UI. The project currently has zero test coverage. This establishes a testing foundation that enables confident development of all other features.

## Requirements
1. Install Vitest as a dev dependency with jsdom environment for React component testing
2. Add a `test` npm script that runs `vitest run`
3. Write unit tests for `utils.ts` (slugify function)
4. Write unit tests for `TaskStore` (create, update, getAll, getById, updatePhase, delete)
5. Write unit tests for `ProcessManager` (createSession, sendMessage, killSession, getAllSessions)
6. Install Playwright as a dev dependency for E2E testing
7. Add a `test:e2e` npm script for Playwright tests
8. Write a Playwright E2E test for the Kanban board page (loads, shows tasks, opens task detail panel)

## Acceptance Criteria
- **Given** `npm test` is run, **When** executed, **Then** all Vitest unit tests pass with no failures
- **Given** `npm run test:e2e` is run, **When** executed, **Then** Playwright launches and the kanban page loads successfully
- **Given** a change to `slugify()` breaks its contract, **When** `npm test` runs, **Then** the slugify test fails
- **Given** a TaskStore test creates a task, **When** `getAll()` is called, **Then** the created task appears in the list
- **Given** a ProcessManager test creates a session, **When** `getAllSessions()` is called, **Then** the session appears

## Files to Modify
- `teamai/package.json` — add vitest dev dep, test/test:e2e scripts
- `teamai/tsconfig.json` — update include/exclude for test files
- New: `teamai/vitest.config.ts` — Vitest configuration with jsdom
- New: `teamai/tests/unit/utils.test.ts` — tests for utils.ts
- New: `teamai/tests/unit/task-store.test.ts` — tests for TaskStore
- New: `teamai/tests/unit/process-manager.test.ts` — tests for ProcessManager
- New: `teamai/playwright.config.ts` — Playwright configuration
- New: `teamai/tests/e2e/kanban.spec.ts` — E2E test for kanban board

## Dependencies & Risks
- Vitest is a drop-in Jest-compatible test runner for Vite projects
- TaskStore tests need a temp directory to avoid polluting real data
- ProcessManager tests can't actually spawn Claude CLI in CI; mock the spawn
- Playwright tests require the dev server running — document this
- Test files are excluded from production builds naturally (in tests/ dir)

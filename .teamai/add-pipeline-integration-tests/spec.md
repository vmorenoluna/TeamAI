# Spec: Add Pipeline Integration Tests

## Scope
Create integration tests that mock the Claude CLI subprocess and verify the full TeamAI pipeline flow through orchestrator phases.

## Background
The unit tests (`orchestrator.test.ts`, `process-manager.test.ts`) test individual methods in isolation. No tests exercise the full pipeline flow: spec → plan → implement → QA review → merge. This leaves pipeline state transitions, error recovery, and rate-limit handling untested.

## Requirements

### R1: Pipeline Flow Integration Test
- Mock `processManager.createSession` to simulate Claude CLI output
- Test that `runTask` creates the correct session for each phase
- Verify phase transitions: spec → plan → implement → qa-review → merge
- Verify `advancePhase` emits the correct `phase-change` events

### R2: QA Loop Test (qa-review → qa-fix → qa-review)
- Test that a FAILING qa-review triggers a qa-fix phase
- Test that after qa-fix, qa-review runs again
- Verify `maxQaAttempts` enforcement — pipeline fails after max attempts

### R3: Recovery / Failure Test
- Test that a crashing session triggers proper error handling
- Test that `_handleSessionExit` advances to the correct recovery phase
- Verify pipelines list is cleaned up in `finally` block

### R4: Rate Limit Handling
- Mock `processManager.createSession` to emit a rate limit error
- Verify `handleRateLimit` is called and retries after the rate window

## Non-Goals
- Not testing PTY terminal sessions
- Not testing WebSocket streaming
- Not testing Docker container integration

## Files
- New: `tests/unit/orchestrator-integration.test.ts`

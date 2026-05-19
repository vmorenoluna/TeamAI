# Spec: Fix Terminal Feature — Wire Up xterm.js PTY Sessions

## Problem
The terminal infrastructure exists (`node-pty`, `ProcessManager.createTerminalSession`, `TerminalPanel`, `TerminalsView`, `TerminalsPage`) but has several issues:
1. No session cleanup when navigating away from the Terminals page — PTY processes leak
2. No "no active sessions" state when returning to the page (terminals created in previous navigation are lost from UI state but PTY keeps running)
3. The terminals page doesn't show how many sessions are currently active server-side

## Requirements

### R1: Session cleanup on unmount
When the TerminalsView unmounts (user navigates away), all active terminal sessions should be killed.

### R2: Server-side session list on page load
The Terminals page should load the list of currently active terminal sessions from the server, so sessions persist across page navigations.

### R3: Empty state improvement
Show a more informative empty state with available roles listed.

## Non-requirements
- No persistence of terminal sessions across server restarts
- No terminal session history/saving

## Acceptance Criteria
- [ ] Terminal sessions are killed when navigating away from Terminals page
- [ ] Active terminal sessions appear when returning to the page
- [ ] No type errors

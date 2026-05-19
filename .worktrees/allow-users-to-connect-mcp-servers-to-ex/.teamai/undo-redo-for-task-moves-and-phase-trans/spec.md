# Spec: Undo/Redo for Task Moves

## Overview
Implement an undo/redo stack for task operations (move, delete) so users can recover from accidental drag-and-drop. Show a subtle toast notification with 'Undo' button.

## Requirements
- Undo stack per-session (in memory, cleared on refresh)
- Last action shown as toast with "Undo" button (auto-dismiss 5s)
- Ctrl+Z to undo last action
- Supports undo of: phase move, task delete

## Affected Files
- `src/components/kanban-board.tsx` — undo stack, toast, Ctrl+Z handler

## Non-Goals
- Redo (can be added later)
- Persistent undo across sessions

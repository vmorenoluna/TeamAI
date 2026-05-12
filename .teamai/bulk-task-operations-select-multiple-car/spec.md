# Spec: Bulk Task Operations

## Overview
Add multi-select to the Kanban board with bulk actions: move selected to phase X, delete selected. Quality-of-life improvement for managing many tasks.

## Requirements
- Ctrl+click / Cmd+click to toggle individual card selection
- Shift+click to select a range
- Bulk action bar appears when ≥1 card is selected
- Bulk actions: Move to phase (dropdown), Delete selected (with confirm)
- Visual: selected cards have highlighted border, checkmark overlay

## Affected Files
- `src/components/kanban-board.tsx` — selection state + bulk action bar
- `src/components/task-card.tsx` — selection visual
- `src/app/actions/tasks.ts` — bulk delete/move server actions

## Non-Goals
- Archive (no archive support yet)
- Drag-select (lasso)

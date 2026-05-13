# Spec: Show Kanban Ticket ID in the Ticket Details

## Overview
Users need to reference kanban tickets by their unique ID (UUID) when discussing tasks, debugging pipeline runs, or cross-referencing tickets. Currently, the task detail panel (`TaskDetail.tsx`) and task card (`TaskCard.tsx`) display the title, description, phase, and metadata — but **not** the task's UUID. This spec adds the task ID display to the detail view.

## Requirements
1. The task's UUID must be visible in the `TaskDetail` component header area.
2. The ID must be displayed in a monospace font for readability.
3. The ID must be copyable (selectable text).
4. The ID display must not disrupt the existing layout or visual hierarchy.
5. The ID should be subtle — secondary information, not competing with the title.

## Acceptance Criteria
- **Given** a user opens any task detail panel, **When** the detail loads, **Then** the task UUID is visible near the title/header area.
- **Given** the task detail is displayed, **When** the user selects the UUID text, **Then** they can copy it to clipboard.
- **Given** the task detail is displayed in readonly mode, **When** readonly mode is active, **Then** the UUID is still visible.
- **Given** the task detail panel is rendered, **When** the UUID is displayed, **Then** it uses a monospace font and subtle styling (e.g., `text-slate-500 text-xs font-mono`).
- **Given** a task with a long UUID, **When** displayed, **Then** the UUID does not overflow or break the layout.

## Files to Modify
| File | Change |
|------|--------|
| `teamai/src/components/task-detail.tsx` | Add `task.id` display in the header section, between breadcrumb/title and description, styled as subtle monospace text |

## Dependencies & Risks
- None. This is a pure UI addition with no backend or data model changes.
- No breaking changes. The `Task` interface already includes `id: string`.

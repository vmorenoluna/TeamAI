# Spec: Task Templates

## Overview
Add pre-defined task templates (Bug Fix, Feature Request, Refactor, Documentation Update) that users can select when creating a new task. Selecting a template pre-fills the title and description with a structured template.

## Requirements
- Templates dropdown in the "New Task" dialog (above the title field)
- Default templates: Bug Fix, Feature Request, Refactor, Documentation Update
- Each template provides a default title prefix and description skeleton
- Optional: suggested role per template
- Selecting a template populates the title+description fields (user can edit)

## Affected Files
- `src/components/kanban-board.tsx` — New Task dialog template selector
- `src/lib/task-store.ts` — (if needed) template storage
- `src/app/actions/tasks.ts` — (if needed) template server action

## Non-Goals
- Custom user-created templates (future)
- Template export/import

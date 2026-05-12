# Spec: Task Search, Filter, and Sort on the Kanban Board

## Overview
Add a search bar, filter controls, and sort options above the Kanban board columns so users can quickly find tasks among potentially dozens of cards.

## Requirements

### Search Bar
- Text input at the top of the board (below the header, above the columns)
- Filters tasks in real-time as the user types (client-side filter)
- Matches against task title AND description (case-insensitive substring match)
- Clear button (×) to reset the search

### Filter Controls
- **Phase filter**: Dropdown/multi-select to show only tasks in specific phases (backlog, spec, plan, implement, qa-review, awaiting-review, merge, failed, done)
- **Priority filter**: If priority metadata exists on tasks, allow filtering by P0/P1/P2/P3
- **Source filter**: Filter by task source (ideation, competitor-analysis)
- Combined with search — filters stack (search + phase filter + source filter all apply)

### Sort Options
- Dropdown with options: Newest first (default), Oldest first, A-Z by title, Z-A by title
- Sorting applies after search/filter

### UX
- Clean, minimal design matching the existing dark theme
- Icons for search (magnifying glass) and sort (chevrons)
- Active filter count badge on filter dropdowns
- Filters persist in memory only (not in URL or localStorage) — reset on page refresh

## Affected Files
- `src/components/kanban-board.tsx` — main implementation
- `src/app/page.tsx` — passes tasks data (no changes needed)

## Non-Goals
- Filter by date range (deferred — needs date picker component)
- Saving filter state across sessions
- Server-side search

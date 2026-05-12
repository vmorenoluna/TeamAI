# Spec: Analytics Dashboard

## Overview
Add dashboard cards to the Insights page showing pipeline metrics: task counts by phase, completion rate, average time per task.

## Requirements
- Stats cards above the chat: Total tasks, Completed, In progress, Completion rate
- Phase distribution bar (simple colored bar showing % in each phase)
- All data computed client-side from existing getTasks() server action

## Affected Files
- `src/app/insights/page.tsx` — add stats cards
- `src/app/actions/insights.ts` — (if needed) data aggregation

## Non-Goals
- Cost tracking (no cost data available)
- Time-series charts (deferred)
- Per-agent metrics

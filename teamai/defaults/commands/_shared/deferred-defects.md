**Deferred defects.** Never drop a defect you scope out of this spec. File it under
`new_tickets` in the backlog check (below), or as an `update` to the open ticket that
already covers it, and also record it in the spec's risks section.

**Backlog impact.** The spec owns the overlap analysis for the change it specifies. Add a
**Backlog impact** section to `spec.md` that lists each open ticket you judged `overlaps`,
`supersedes` or `invalidates`, with its `id` and one line on why, or states "none". The
planner reads this section to sequence around overlapping work.

<!-- @include _shared/backlog-effects.md -->

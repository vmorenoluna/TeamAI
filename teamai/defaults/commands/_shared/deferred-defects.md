**Deferred defects.** Never drop a defect you scope out of this spec, and never hand-write ticket files — there is no ticket CLI in a pipeline session. Report each one on its own line in your final output, with its evidence in the description:
`[BUG] Fix: {short imperative title} — {one-sentence description with the evidence}`
The orchestrator files each line as a backlog ticket (prefixes: `Fix`, `Feat`, `Refactor`, `Docs`). Also record the defect in the spec's risks section.

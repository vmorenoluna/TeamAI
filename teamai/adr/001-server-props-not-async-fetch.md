# ADR 001: Server Props, Not Async Fetch — Client Component Data-Flow Convention

**Date:** 2026-07-03

**Status:** Accepted

**Context**

TeamAI's layout re-renders frequently. The `usePhaseSync` hook listens for WebSocket `phase-change` events and calls `router.refresh()` on every one — including rate-limit pauses. This re-renders `layout.tsx`, which re-mounts every client component in the header.

If a client component initializes a persistent toggleable state with a literal default and then async-fetches its real value in a mount `useEffect`, **that state resets to the literal default on every `router.refresh()`**. The user sees the wrong value until the async fetch completes — and in fast-moving pipelines, the fetch may never complete before the next refresh.

**Exhibit: The AutoModeButton Bug**

The original `AutoModeButton` had this pattern:

```tsx
// ❌ Antipattern
function AutoModeButton() {
  const [enabled, setEnabled] = useState(false);          // defaults to false
  useEffect(() => {
    getAutoModeStateAction().then(s => setEnabled(s.enabled)); // async-fetches real state
  }, []);
  // ...
}
```

When a rate limit hit, `usePhaseSync` called `router.refresh()`. The button re-mounted, `enabled` reset to `false`, and the button appeared disabled even though auto mode was still running. The user could not stop auto mode — the button was stuck showing the wrong state.

**Decision**

**Client components must never initialize persistent toggleable state with a literal default and then async-fetch the real value in a mount effect.** Initial state must come from the server component as a prop. (Async-fetching supplementary data that doesn't overwrite a literal-initialized state is fine.)

**Correct pattern:**

```tsx
// ✅ Correct: Server component fetches, client component renders
// layout.tsx (Server Component)
const state = getAutoModeState(project.path);
return <AutoModeButton initialEnabled={state.enabled} />;

// auto-mode-button.tsx (Client Component)
function AutoModeButton({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled); // survives refresh
  // ...
}
```

**Why `initialEnabled` survives `router.refresh()`:**

1. `layout.tsx` is a Server Component — it reads `getAutoModeState()` from the in-memory `Map` (synchronous, zero latency) on every render
2. When `router.refresh()` triggers a re-render, the server component re-reads the authoritative state and passes it as `initialEnabled`
3. The client component's `useState(initialEnabled)` initializes with the correct value — no flash of wrong state, no async fetch

The state only changes when the user clicks the button (optimistic toggle → server action → next refresh picks up new server state).

**Enforcement**

An ESLint rule (`local/no-async-fetch-on-mount`) detects the antipattern at build/lint time:

- Tracks `useState(literal)` declarations and `useEffect(callback, [])` with async operations (await, .then, .catch, .finally)
- Cross-references: if an async mount-effect calls a setter from a literal-initialized useState, it reports a warning
- Configured in `eslint.config.mjs` for all `src/**/*.tsx` files

**Scope**

This convention applies to **persistent, user-toggleable state**. It does not apply to:

- **Ephemeral UI state**: dropdown openness, dialog visibility — resetting these on refresh is correct behavior
- **Data-loading state**: fetching a list of items on mount — re-fetching on refresh is intentional
- **Terminal/session initialization**: initializing xterm.js, creating WebSocket connections — these must re-init on remount

See the `eslint-disable-next-line` comments in `agent-panel.tsx`, `github-import.tsx`, and `projects-settings.tsx` for examples of legitimate exceptions.

**Components following this convention (layout.tsx header):**

| Component          | Server Prop          | Source                                    |
|--------------------|----------------------|-------------------------------------------|
| `AutoModeButton`   | `initialEnabled`     | `getAutoModeState(activeProject.path)`    |
| `DefaultsUpdater`  | `initialReport`      | `getDefaultsSyncReport()`                 |
| `Sidebar`          | `projects`, `path`   | `getProjects()` / `getActiveProject()`    |
| `ProjectSelector`  | `projects`, `path`   | `getProjects()` / `getActiveProject()`    |

**Test coverage**

- `tests/unit/auto-mode-button.test.tsx` — Verifies enabled/disabled state survives unmount+remount (simulating `router.refresh()`)
- `tests/unit/eslint-rules.test.ts` — 15 rule tests: 9 valid patterns (prop-init, sync-effect, cross-match avoidance, etc.) + 6 invalid (await, .then, .catch, literal types)

**Consequences**

- **Positive**: Header state is stable across phase changes, rate limits, and reconnection events. No visual flicker or wrong-state bugs.
- **Positive**: ESLint rule prevents reintroduction of the antipattern in new components.
- **Negative**: Component APIs must include `initialX` props even for state that could theoretically be fetched client-side. This adds a prop to the interface but removes an async fetch and loading state from the implementation — a net reduction in complexity.

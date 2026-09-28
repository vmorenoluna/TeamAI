# ShopForge Demo Project

A fake e-commerce demo project for TeamAI screenshots and demonstration. Contains 19 pre-seeded tasks across every pipeline phase, a 14-item roadmap, and a throwaway git history so the DONE column has reconstructable tickets.

Everything in it is fabricated — tasks, agent logs, git history, and pull requests alike. Nothing is fetched or validated against a real service; the demo exists so the UI has something realistic to render.

## Quick Start

```bash
# 1. Re-seed the demo (from project root)
npx tsx seed-demo.ts --yes

# 2. Launch the Electron app
cd teamai && npm run electron:dev

# 3. Register the demo project in the app UI
#    Path: <path-to-your-clone>/demo
#    Name: ShopForge
```

## Demo Flag

The seed script sets `"demo": true` in `pipeline.json`. This tells TeamAI to **skip all pipeline processing** for this project — the orchestrator and auto-mode both check this field and silently no-op when it's `true`. Tasks stay in their seeded phases indefinitely.

To let TeamAI process tasks normally:
```bash
# Edit demo/.teamai/pipeline.json and remove or set "demo": false
```

## Task Breakdown

| Phase | Count | Examples |
|---|---|---|
| Backlog | 3 | Product Recommendation Engine, Multi-Currency Checkout, Inventory Alert System |
| Spec | 2 | One-Click Reorder, Abandoned Cart Recovery |
| Plan | 2 | BNPL (Klarna/Affirm), Customer Reviews with Photos |
| Implement | 2 | Cart quantity fix, Shipping Rate Calculator |
| QA Review | 2 | Search partial match fix, Mobile nav menu fix |
| Awaiting Review | 3 | Dark Mode, Wishlist, **Tax Rules for EU Countries** (parked by a failure) |
| PR Open | 1 | **Promo Code Stacking Rules** (one log per agent role) |
| Done | 3 | Order Tracking Dashboard, Guest Checkout, Cart total rounding |
| Failed | 1 | Checkout timeout (3 QA attempts) |

## Showcase Data

Three seeded tickets exist specifically to make these features visible in screenshots:

| Ticket | Column / status | What it shows |
|---|---|---|
| Promo Code Stacking Rules | Review, **PR Open** | One fake log per agent role plus the orchestrator, so the Terminal tab has a filter entry for every role |
| Tax Rules for EU Countries | Review, Awaiting Review | Parked by a **failure**, not a QA pass — its `awaitingReviewReason` drives the "Needs attention" card badge and review-panel banner |
| Checkout Timeout Under High Load | Failed | Failed acceptance criteria and QA recommendations on the task overview |

### Per-role logs (Promo Code Stacking Rules)

`demo/.teamai/promo-code-stacking-rules/` holds one log per pipeline role. These are the files the task's Terminal tab filters by:

| File | Terminal tab entry |
|---|---|
| `output.log` | Orchestrator |
| `output-spec.log` | Spec (Analyst) |
| `output-plan.log` | Plan (Planner) |
| `output-st1.log`, `output-st2.log` | Coder (one per plan.json subtask) |
| `output-qa.log` | QA Review |
| `output-merge.log` | Merge (Merger) |

Prefix lines with `[YYYY-MM-DDTHH:MM:SS] ` — that is the format the terminal parses to put a timestamp on each line. Undated lines fall back to `00:00:00`.

### DONE history

The DONE column shows the three disk tasks (each with a fake `prUrl`, which renders as the green `PR` link) and, underneath them, tickets the app reconstructs from the repo's own git history. That history is a throwaway repo the seed creates at `demo/.git`, with five dated commits carrying the trailers the scanner greps for (`Task:`, `Task-ID:`, `QA:`, `Phases:`).

The PR numbers are invented, and the URLs are only shaped like GitHub ones (`shopforge/shopforge/pull/137`) so the UI has something to render as a link. That repository does not exist, so they 404 if clicked, and nothing in the app tries to open or check them — auto-mode's CI polling is the only code path that would hand a task's `prUrl` to `gh`, and the demo flag halts auto-mode.

`demo/src/` and `demo/.git/` are gitignored by the TeamAI repo — both are generated, so none of the demo's fake history is committed upstream. Because the demo has no GitHub remote, the scanner's PR-body lookup logs `no git remotes found` and falls back to commit trailers alone; those cards therefore have no PR link, which is expected.

## Roadmap

14 items across 4 phases (Now, Next, Later, Icebox) with competitor analysis.

## Re-seeding

The seed script is at the project root (`seed-demo.ts`) so it survives demo directory wipes:

```bash
npx tsx seed-demo.ts --yes
```

This wipes and recreates `demo/.teamai/`, `demo/.claude/`, `demo/src/` and `demo/.git/`.

## Screenshots

Capture screenshots from the running app and save them to `docs/images/` — the landing page reads them by relative path from there, so no build step is involved.

All 11 `<img>` tags on the page now carry a `width` and `height`, so lazy loading never shifts the layout.

The three newest sections on `docs/index.html` have live `<img>` tags pointing at screenshots that may not exist yet, so saving the file into `docs/images/` is all that's needed — no HTML edit. Each tag carries a reserved `width`/`height` (taken from the closest matching existing screenshot) to cut layout shift while the image loads, plus an `onerror` that removes the tag while the file is missing, so there's no broken-image icon:

| File | Capture |
|---|---|
| `docs/images/terminals.jpg` | Terminals page with a live session open |
| `docs/images/diagnostics.jpg` | A failed task's overview, plus a "Needs attention" parked ticket |
| `docs/images/delivered.jpg` | The DONE column: PR links on the disk tasks and history cards below |

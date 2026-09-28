// Seed script for the ShopForge e-commerce demo project.
// Creates 19 tasks covering every pipeline phase and a roadmap with 14 items.
// Usage: npx tsx seed-demo.ts [--yes] [--logs-only] (logs-only never reseeds demo data)
//
// Everything here is fabricated: the tasks, the agent logs, the git history, and
// the pull requests. The PR URLs are placeholder strings shaped like GitHub URLs
// (e.g. shopforge/shopforge) purely so the UI has something to render as a PR
// link. They point at no real repo, nothing in the app fetches them, and they are
// not meant to resolve — don't "fix" them by aiming at a real repository.
//
// Put at project root (outside demo/) so re-seeding doesn't wipe this script.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { execFileSync } from 'child_process';

const DEMO_DIR = join(process.cwd(), 'demo');
const DEFAULTS_DIR = join(process.cwd(), 'teamai', 'defaults');
const TEAMAI_DIR = join(DEMO_DIR, '.teamai');

const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes') || args.includes('-y');
const logsOnly = args.includes('--logs-only');

if (!skipConfirm && !logsOnly) {
  console.log('This will DELETE and re-create demo/.teamai/, demo/.claude/, demo/src/ and demo/.git/.');
  console.log('Run with --yes to skip this prompt.');
  process.exit(0);
}

function rmDir(dir: string) {
  if (!existsSync(dir)) return;
  rmSync(dir, { recursive: true, force: true });
}

// ── Scaffold .claude/ ──────────────────────────────────────────────

function scaffoldClaude() {
  const claudeDir = join(DEMO_DIR, '.claude');
  mkdirSync(claudeDir, { recursive: true });

  // Copy roles
  const rolesSrc = join(DEFAULTS_DIR, 'roles');
  const rolesDest = join(claudeDir, 'roles');
  mkdirSync(rolesDest, { recursive: true });
  for (const file of readdirSync(rolesSrc)) {
    const dest = join(rolesDest, file);
    if (!existsSync(dest)) cpSync(join(rolesSrc, file), dest);
  }

  // Copy commands
  const cmdsSrc = join(DEFAULTS_DIR, 'commands');
  const cmdsDest = join(claudeDir, 'commands');
  mkdirSync(cmdsDest, { recursive: true });
  for (const file of readdirSync(cmdsSrc)) {
    const dest = join(cmdsDest, file);
    if (!existsSync(dest)) cpSync(join(cmdsSrc, file), dest);
  }

  // Copy teamai-workflow.md
  const workflowSrc = join(DEFAULTS_DIR, 'teamai-workflow.md');
  const workflowDest = join(claudeDir, 'teamai-workflow.md');
  if (existsSync(workflowSrc)) cpSync(workflowSrc, workflowDest);

  // Write CLAUDE.md at demo root
  writeFileSync(join(DEMO_DIR, 'CLAUDE.md'), '@.claude/teamai-workflow.md\n');
}

// ── Task definitions ────────────────────────────────────────────────

interface SeedTask {
  id: string;
  title: string;
  description: string;
  phase: string;
  spec?: string;
  plan?: object;
  qaReport?: object;
  completionSummary?: string;
  /** Written to output.log — the terminal tab's 'Orchestrator' role. */
  outputLog?: string;
  diff?: string;
  events: string[];  // phase names in order
  source?: string;
  competitiveContext?: string;
  /** Fake PR link — renders as the green 'PR' link on the task card and in
   *  the review panel. Nothing in the demo resolves it. */
  prUrl?: string;
  mergeStrategy?: string;
  /** Non-null only when the task was parked on awaiting-review by a FAILURE
   *  (spec phase producing no spec.md/spec_summary.md, a no-op revision, a
   *  rolled-back approval) rather than by a genuine QA pass. Drives the
   *  'Needs attention' card badge and the review-panel banner. */
  awaitingReviewReason?: string;
  failureReason?: string;
  /** Extra per-role log files written next to output.log. Keys are file
   *  names, and each maps to one terminal-tab role:
   *    output-spec.log  → Spec (Analyst)
   *    output-plan.log  → Plan (Planner)
   *    output-st<N>.log → Coder (one per plan.json subtask id)
   *    output-qa.log    → QA Review
   *    output-merge.log → Merge (Merger)
   *  Lines should start with '[YYYY-MM-DDTHH:MM:SS] ' so the terminal renders
   *  a timestamp per line (undated lines fall back to 00:00:00). */
  roleLogs?: Record<string, string>;
}

/**
 * Add deterministic full timestamps to a scripted terminal transcript. The
 * UI sorts lines from every role log by this timestamp, so these values also
 * define the demo's cross-agent chronology. QA→merge transcripts include a
 * deliberate 20-minute handoff before the merger session starts.
 */
function timestampDemoLog(transcript: string, startedAt: string): string {
  let cursor = Date.parse(`${startedAt}Z`);
  if (!Number.isFinite(cursor)) throw new Error(`Invalid demo log start time: ${startedAt}`);

  return transcript.split('\n').map((line) => {
    if (!line.trim()) return line;

    if (line.startsWith('[MERGE]')) cursor += 20 * 60 * 1000;
    const timestamp = new Date(cursor).toISOString().slice(0, 19);

    // Model a little time passing between events; testing / CI and explicit
    // waits take longer than a file read or a line of agent commentary.
    const lower = line.toLowerCase();
    const delay = line.startsWith('> Running acceptance tests') || line.startsWith('> Running API integration tests')
      || line.startsWith('> Running visual regression tests') ? 4 * 60 * 1000
      : lower.includes('ci checks queued') ? 3 * 60 * 1000
      : lower.includes('passed in ') ? 45 * 1000
      : lower.startsWith('> writing') || lower.startsWith('> creating pr') || lower.startsWith('> merging pr') ? 30 * 1000
      : line.startsWith('  ') ? 8 * 1000
      : 20 * 1000;
    // The implement samples explicitly say the coder is still within a
    // six-minute session budget, so keep their simulated elapsed time aligned.
    const pace = transcript.startsWith('[IMPLEMENT]') ? 0.5 : 1;
    cursor += Math.round(delay * pace);

    return `[${timestamp}] ${line}`;
  }).join('\n');
}

const TASKS: SeedTask[] = [
  // ═══ BACKLOG (3) ═══
  {
    id: 'BACKLOG-001',
    title: 'Product Recommendation Engine',
    description: 'Build an ML-powered product recommendation engine that suggests items based on browsing history, purchase patterns, and similar-user behavior.',
    phase: 'backlog',
    events: ['backlog'],
  },
  {
    id: 'BACKLOG-002',
    title: 'Multi-Currency Checkout',
    description: 'Support checkout in multiple currencies with real-time exchange rates. Display prices in the user\'s local currency throughout the shopping flow.',
    phase: 'backlog',
    events: ['backlog'],
  },
  {
    id: 'BACKLOG-003',
    title: 'Inventory Alert System',
    description: 'Real-time inventory tracking with alerts when stock drops below threshold. Auto-notify warehouse team and temporarily hide out-of-stock items.',
    phase: 'backlog',
    events: ['backlog'],
  },

  // ═══ SPEC (2) ═══
  {
    id: 'SPEC-001',
    title: 'One-Click Reorder',
    description: 'Allow logged-in users to reorder their previous purchases with a single click from order history.',
    phase: 'spec',
    spec: `# One-Click Reorder Feature Specification

## Overview
Enable authenticated users to reorder any previous purchase with a single click from their order history page. The system should reuse the saved payment method and shipping address from the original order.

## Acceptance Criteria
1. User sees a "Reorder" button next to each completed order in order history
2. Clicking "Reorder" creates a new order with identical line items
3. Saved payment method and shipping address are auto-applied
4. Order confirmation page shows within 3 seconds of clicking
5. If payment method is expired, user is prompted to update before order is placed
6. Out-of-stock items are flagged with a warning before order placement
`,
    events: ['backlog', 'spec'],
  },
  {
    id: 'SPEC-002',
    title: 'Abandoned Cart Email Recovery',
    description: 'Send automated reminder emails to users who add items to cart but don\'t complete checkout within 4 hours.',
    phase: 'spec',
    spec: `# Abandoned Cart Email Recovery

## Overview
Automatically detect abandoned carts (items added, no checkout within 4 hours) and send a sequence of up to 3 reminder emails with increasing urgency and discounts.

## Acceptance Criteria
1. Cart is marked "abandoned" after 4 hours of inactivity
2. First reminder email sent at 4 hours with product images and a "Return to cart" CTA
3. Second reminder at 24 hours with a 5% discount code
4. Third reminder at 72 hours with a 10% discount code
5. Email sequence stops immediately upon checkout completion
6. User can opt out of cart reminder emails from any email
`,
    events: ['backlog', 'spec'],
  },

  // ═══ PLAN (2) ═══
  {
    id: 'PLAN-001',
    title: 'Payment Method: Buy Now Pay Later (Klarna / Affirm)',
    description: 'Integrate BNPL options from Klarna and Affirm as payment methods during checkout.',
    phase: 'plan',
    plan: {
      subtasks: [
        { id: 1, title: 'Integrate Klarna Payments SDK', acceptance_criteria: ['Klarna widget renders in checkout', 'Test mode processes a successful payment'], depends_on: [] },
        { id: 2, title: 'Integrate Affirm SDK', acceptance_criteria: ['Affirm modal opens on payment selection', 'Test mode processes a successful payment'], depends_on: [] },
        { id: 3, title: 'Add BNPL eligibility check', acceptance_criteria: ['Order total must be $50-$1000', 'User must be in a supported country'], depends_on: [] },
        { id: 4, title: 'Update order confirmation UI for BNPL', acceptance_criteria: ['Shows installment schedule', 'Shows provider name and contact'], depends_on: [1, 2] },
      ],
    },
    events: ['backlog', 'spec', 'plan'],
  },
  {
    id: 'PLAN-002',
    title: 'Customer Reviews with Photo Upload',
    description: 'Allow verified purchasers to leave star ratings, written reviews, and upload photos of their purchase.',
    phase: 'plan',
    plan: {
      subtasks: [
        { id: 1, title: 'Build review submission form', acceptance_criteria: ['Star rating component works', 'Text review field with 50-2000 char limit', 'Photo upload with drag-and-drop'], depends_on: [] },
        { id: 2, title: 'Image moderation pipeline', acceptance_criteria: ['Uploaded images are scanned for NSFW content', 'Clean images are resized to 800x800 max'], depends_on: [1] },
        { id: 3, title: 'Review display on product page', acceptance_criteria: ['Reviews sorted by most recent', 'Photos open in lightbox', 'Verified purchase badge shown'], depends_on: [2] },
      ],
    },
    events: ['backlog', 'spec', 'plan'],
  },

  // ═══ IMPLEMENT (2) ═══
  {
    id: 'IMPL-001',
    title: 'Fix Cart Quantity Update Not Persisting on Page Refresh',
    description: 'Cart quantity changes (increase/decrease) update visually but revert to previous values on page refresh. The state is only stored in React local state, not synced to the backend.',
    phase: 'implement',
    spec: '# Cart Quantity Persistence Fix\n\n## Problem\nCart quantity updates don\'t persist across page refreshes.\n\n## Acceptance Criteria\n1. Quantity changes are immediately synced to the backend via PATCH /api/cart/:itemId\n2. Cart total recalculates after each quantity change\n3. Page refresh shows the correct quantities\n4. If the API call fails, the UI reverts to the previous value and shows an error toast\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Add PATCH /api/cart/:itemId endpoint for quantity persistence', acceptance_criteria: ['Endpoint accepts { quantity: number } and returns updated cart', 'Validates quantity is positive integer within stock limits', 'Returns 404 for non-existent cart items', 'Returns 422 for invalid quantity values'], completed: true },
        { id: 2, title: 'Wire up frontend quantity controls to API calls', acceptance_criteria: ['+/- buttons call PATCH endpoint on change', 'Cart total recalculates from API response (not local state)', 'Loading spinner shows during API call', 'Page refresh shows correct persisted quantities'], completed: true },
        { id: 3, title: 'Implement optimistic updates with rollback on failure', acceptance_criteria: ['UI updates immediately on click (optimistic)', 'On API error, UI reverts to previous value', "Error toast appears with 'Failed to update quantity' message", 'Retry button in toast lets user re-attempt the update'], completed: false },
        { id: 4, title: 'Add integration tests for cart persistence flow', acceptance_criteria: ['Test: quantity change persists across page refresh', 'Test: optimistic update rolls back on network error', 'Test: error toast appears and retry works', 'Test: cart total updates correctly after quantity change'], completed: false },
      ],
    },
    outputLog: timestampDemoLog(`[IMPLEMENT] Cart Quantity Fix — Subtask 3/4: Optimistic updates with rollback
[SESSION] Claude Code v2.4.1 — coder persona loaded

> Reading plan.json for task context...
  Subtask 1: ✓ Add PATCH /api/cart/:itemId endpoint
  Subtask 2: ✓ Wire up frontend quantity controls
  Subtask 3: → Implement optimistic updates with rollback (current)
  Subtask 4: ○ Add integration tests

> Reading src/components/CartItem.tsx...
  Found QuantityControl component at line 142
  Current implementation: direct state mutation, no error handling

> Editing src/components/CartItem.tsx...
  + Added useOptimistic() hook for immediate UI feedback
  + Added useEffect rollback on API error state
  + Added toast notification on failure
  + Extracted quantity update logic into useCartMutation()

> Editing src/hooks/useCartMutation.ts (new file)...
  + Created custom hook wrapping PATCH /api/cart/:itemId
  + Returns { updateQuantity, isPending, error }
  + Exposes retry() function for failed updates
  + Debounces rapid clicks (200ms)

> Reading src/components/Toast.tsx...
  Existing toast system supports: success, error, warning, info variants.

> Editing src/components/CartItem.tsx...
  + Imported ToastContext
  + Error toast: "Failed to update quantity — tap to retry"
  + Retry button re-invokes the last failed mutation

> Running typecheck: npx tsc --noEmit...
  ✅ No type errors

> Running existing tests: npx vitest run --reporter=verbose...
  ✓ CartItem renders quantity controls (12ms)
  ✓ Quantity increment calls handler (8ms)
  ✓ Quantity decrement calls handler (7ms)
  ✓ Cart total recalculates on quantity change (15ms)
  ⚠ No tests yet for optimistic update / rollback (skipped)

> Subtask 3 status: Optimistic update logic written.
  Rollback on error: implemented via useEffect watching error state.
  Next: write integration tests (subtask 4).

[WAITING] Claude session budget: 42% remaining (3.5min of 6min used)
`, '2026-09-04T10:00:00'),
    events: ['backlog', 'spec', 'plan', 'implement'],
  },
  {
    id: 'IMPL-002',
    title: 'Shipping Rate Calculator Based on Weight and Distance',
    description: 'Replace the flat-rate shipping with a dynamic calculator that factors in package weight, dimensions, and delivery distance.',
    phase: 'implement',
    spec: '# Shipping Rate Calculator\n\n## Overview\nDynamic shipping rates based on package weight (0.1-30kg), dimensions, and delivery zone.\n\n## Acceptance Criteria\n1. Rate is calculated as: base_rate + (weight_kg * 1.50) + (zone_multiplier * 2.00)\n2. Three delivery zones: Local (1x), Regional (1.5x), National (2.5x)\n3. Free shipping for orders over $75\n4. Rate is shown before the user enters payment details\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Implement weight-based rate formula', acceptance_criteria: ['Rate = base_rate + (weight_kg * 1.50) + (zone_multiplier * 2.00)', 'Weight range: 0.1kg to 30kg', 'Base rate: $5.00 for domestic, $8.00 for international', 'Weight is rounded up to nearest 0.1kg'], completed: true },
        { id: 2, title: 'Add delivery zone detection from shipping address', acceptance_criteria: ['Zone Local (1x): same city as warehouse', 'Zone Regional (1.5x): same state/region', 'Zone National (2.5x): different state/region', 'Zone detection uses postal code lookup against zone map'], completed: true },
        { id: 3, title: 'Integrate free shipping threshold ($75)', acceptance_criteria: ["Orders over $75 show '$0.00' for shipping", 'Threshold is calculated on subtotal (before tax)', 'Free shipping badge shown in cart when eligible', 'Threshold is configurable via SHIPPING_FREE_THRESHOLD env var'], completed: false },
        { id: 4, title: 'Show shipping rate before payment step in checkout', acceptance_criteria: ['Rate displayed on cart page after address entry', 'Rate updates when shipping address changes', 'Multiple shipping options shown if available (standard, express)', 'Selected option is persisted through to order confirmation'], completed: false },
        { id: 5, title: 'Add unit tests for shipping calculator', acceptance_criteria: ['Test: 2kg package to Local zone = $8.00', 'Test: 5kg package to National zone = $17.50', 'Test: orders over $75 get free shipping', 'Test: weight below 0.1kg rounds up to 0.1kg', 'Test: weight above 30kg returns validation error'], completed: false },
      ],
    },
    outputLog: timestampDemoLog(`[IMPLEMENT] Shipping Rate Calculator — Subtask 3/5: Free shipping threshold
[SESSION] Claude Code v2.4.1 — coder persona loaded

> Reading plan.json for task context...
  Subtask 1: ✓ Weight-based rate formula
  Subtask 2: ✓ Delivery zone detection from postal codes
  Subtask 3: → Free shipping threshold ($75) (current)
  Subtask 4: ○ Show rate before payment step
  Subtask 5: ○ Unit tests

> Reading src/shipping/calculator.ts...
  Current calculateShipping(weight, zone) returns number.
  No free-shipping logic present yet.

> Editing src/shipping/calculator.ts...
  + Added optional subtotal parameter: calculateShipping(weight, zone, subtotal?)
  + Early return 0 when subtotal >= FREE_SHIPPING_THRESHOLD
  + FREE_SHIPPING_THRESHOLD read from process.env (defaults to 75)

> Reading .env.example...
  Added SHIPPING_FREE_THRESHOLD=75

> Reading src/components/CartSummary.tsx...
  Found shipping line item at line 89. Currently shows static "$5.00".

> Editing src/components/CartSummary.tsx...
  + Calculate subtotal from cart items
  + Pass subtotal to calculateShipping()
  + Show "$0.00" with "Free Shipping ✓" badge when threshold met
  + Added tooltip: "Free shipping on orders over $75"

> Editing src/shipping/calculator.ts...
  + Added getFreeShippingProgress(subtotal): { remaining, percentComplete }
  + Returns amount left to qualify for free shipping

> Running typecheck: npx tsc --noEmit...
  ✅ No type errors

> Running existing tests: npx vitest run src/shipping/ --reporter=verbose...
  ✓ 2kg Local zone = $8.00 (3ms)
  ✓ 5kg National zone = $17.50 (2ms)
  ✓ 0.1kg Regional zone = $8.15 (1ms)
  ⚠ No free-shipping threshold tests yet

> Subtask 3 status: Free shipping logic implemented.
  Orders $75+ get free shipping. Progress bar shows "Add $X.XX for free shipping".
  Next: wire rate display into checkout flow (subtask 4).

[WAITING] Claude session budget: 38% remaining (3.7min of 6min used)
`, '2026-09-05T11:00:00'),
    events: ['backlog', 'spec', 'plan', 'implement'],
  },

  // ═══ QA REVIEW (2) ═══
  {
    id: 'QA-001',
    title: 'Fix Search Returns Empty Results for Partial Product Names',
    description: 'Full-text search only matches exact product names. Partial matches like "running sho" should return "Running Shoes".',
    phase: 'qa-review',
    spec: '# Search Partial Match\n\n## Acceptance Criteria\n1. Search for "running sho" returns "Running Shoes"\n2. Search is case-insensitive\n3. Search supports prefix matching (first 3+ chars)\n4. Empty search returns all products (not zero results)\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Replace exact-match search with case-insensitive includes()', acceptance_criteria: ['"running sho" matches "Running Shoes"', '"RUNNING" matches "Running Shoes"', 'Empty string returns all products'], completed: true },
        { id: 2, title: 'Implement prefix matching for queries of 3+ characters', acceptance_criteria: ['"run" (3 chars) returns products starting with "run"', 'Prefix matching is case-insensitive', 'Shorter queries (< 3 chars) fall back to includes() behavior'], completed: false },
        { id: 3, title: 'Add search index rebuild on product catalog update', acceptance_criteria: ['Index is rebuilt when products are added/removed/updated', 'Rebuild runs asynchronously without blocking search requests', 'Stale index is detected and re-rebuilt on next search'], completed: false },
        { id: 4, title: 'Add integration tests for search behavior', acceptance_criteria: ['Test: partial match returns correct results', 'Test: prefix match returns correct results', 'Test: case insensitivity works across Unicode characters'], completed: false },
      ],
    },
    qaReport: {
      overall: 'FAIL',
      criteria: [
        { name: 'Partial match', status: 'FAIL', notes: 'Search for "running sho" returns 0 results. Only exact matches work.' },
        { name: 'Case insensitive', status: 'PASS', notes: '"RUNNING SHOES" matches correctly.' },
        { name: 'Prefix matching', status: 'FAIL', notes: 'Search for "run" (3 chars) returns 0 results. Prefix matching not implemented.' },
        { name: 'Empty search', status: 'PASS', notes: 'Empty search returns all 452 products.' },
      ],
      additional_issues: [
        { severity: 'critical', description: 'Partial match algorithm not implemented at all — search only uses exact string comparison', file: 'src/search.ts' },
        { severity: 'warning', description: 'Search index should be rebuilt after product catalog updates', file: 'src/search.ts' },
      ],
    },
    outputLog: timestampDemoLog(`[QA-REVIEW] Search Partial Match — Attempt 1
[SESSION] Claude Code v2.4.1 — qa-reviewer persona loaded

> Reading spec.md...
  AC1: Search for "running sho" returns "Running Shoes"
  AC2: Case-insensitive search
  AC3: Prefix matching (3+ chars)
  AC4: Empty search returns all products

> Reading plan.json for expected implementation scope...
  4 subtasks found, checking completion status via git log...

> Reading src/search.ts...
  Line 47: const results = products.filter(p => p.name === query);
  ⚠ Exact-match comparison — no partial or prefix matching

> Running acceptance tests against local dev server...

  Test 1: Partial match "running sho"
    Request: GET /api/search?q=running+sho
    Response: { results: [], total: 0 }
    Expected: At least 1 result (Running Shoes)
    ❌ FAIL — 0 results returned

  Test 2: Case insensitivity "RUNNING SHOES"
    Request: GET /api/search?q=RUNNING+SHOES
    Response: { results: [{ name: "Running Shoes", ... }], total: 1 }
    ✅ PASS

  Test 3: Prefix matching "run"
    Request: GET /api/search?q=run
    Response: { results: [], total: 0 }
    Expected: At least 1 result (prefix "run" matches "Running Shoes")
    ❌ FAIL — Prefix matching not implemented

  Test 4: Empty search
    Request: GET /api/search?q=
    Response: { results: [...452 products], total: 452 }
    ✅ PASS

> Summary: 2/4 criteria PASS, 2 FAIL
  Blockers: Partial match and prefix matching both use === comparison.
  Root cause: src/search.ts line 47 — p.name === query

> Writing qa_report.json...
  overall: FAIL
  criteria[partial_match]: FAIL — Exact comparison only
  criteria[case_insensitive]: PASS
  criteria[prefix_matching]: FAIL — Not implemented
  criteria[empty_search]: PASS
  additional_issues[0]: critical — Partial match algorithm missing (src/search.ts)
  additional_issues[1]: warning — Search index should rebuild on catalog update (src/search.ts)

> Generating qa_feedback.md for implementer...
  Tagged subtask matching src/search.ts with [QA CORRECTION] annotations.

[QA COMPLETE] Report written to qa_report.json. Task bounced back to implement phase.
`, '2026-08-13T13:00:00'),
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review'],
  },
  {
    id: 'QA-002',
    title: 'Fix Mobile Nav Menu Doesn\'t Close After Link Click',
    description: 'On mobile, the hamburger menu stays open after clicking a navigation link. It should auto-close on link click.',
    phase: 'qa-review',
    spec: '# Mobile Nav Auto-Close\n\n## Acceptance Criteria\n1. Clicking any nav link in the mobile menu closes the menu\n2. Tapping the overlay/backdrop closes the menu\n3. Menu close animation is smooth (200ms slide-out)\n4. Focus is returned to the hamburger button after close\n5. Menu state is reset on viewport resize from mobile to desktop\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Add onClick handler to MobileNavLink components', acceptance_criteria: ['All nav links in mobile menu have onClick that calls closeMenu()', 'Links still navigate correctly after closeMenu runs', 'Menu closing does not block navigation (no preventDefault)'], completed: true },
        { id: 2, title: 'Implement focus management after menu close', acceptance_criteria: ['After menu closes, focus returns to hamburger button', 'Focus trap is released when menu closes', 'Tab key does not focus hidden menu items after close'], completed: false },
        { id: 3, title: 'Add viewport resize listener to reset menu state', acceptance_criteria: ['Menu closes when viewport expands past mobile breakpoint (768px)', 'Menu state is clean when resizing back to mobile', 'No visual flash during resize transition'], completed: false },
        { id: 4, title: 'Add unit tests for mobile nav behavior', acceptance_criteria: ['Test: clicking nav link closes menu on mobile', 'Test: focus returns to hamburger after close', 'Test: menu closes on resize to desktop width'], completed: false },
      ],
    },
    qaReport: {
      overall: 'FAIL',
      criteria: [
        { name: 'Close on link click', status: 'FAIL', notes: 'Menu stays open — onClick handler is missing on nav links' },
        { name: 'Close on overlay tap', status: 'PASS', notes: 'Backdrop click closes menu correctly.' },
        { name: 'Smooth animation', status: 'PASS', notes: 'Transition is smooth at 200ms.' },
        { name: 'Focus return', status: 'FAIL', notes: 'After closing, focus goes to document body instead of hamburger button.' },
        { name: 'Viewport resize', status: 'FAIL', notes: 'Menu stays open in desktop view after resize from mobile.' },
      ],
      additional_issues: [
        { severity: 'critical', description: 'Missing onClick handler on all MobileNavLink components', file: 'src/components/MobileNav.tsx' },
        { severity: 'error', description: 'Focus management after menu close is missing', file: 'src/components/MobileNav.tsx' },
        { severity: 'suggestion', description: 'Consider using a Headless UI Dialog for better a11y', file: 'src/components/MobileNav.tsx' },
      ],
    },
    outputLog: timestampDemoLog(`[QA-REVIEW] Mobile Nav Auto-Close — Attempt 1
[SESSION] Claude Code v2.4.1 — qa-reviewer persona loaded

> Reading spec.md...
  AC1: Click any nav link closes the menu
  AC2: Overlay/backdrop tap closes the menu
  AC3: Smooth 200ms slide-out animation
  AC4: Focus returns to hamburger button after close
  AC5: Menu state resets on viewport resize (mobile→desktop)

> Reading plan.json for expected implementation scope...
  4 subtasks found, checking completion status via git log...

> Reading src/components/MobileNav.tsx...
  Line 32: <MobileNavLink href="/products"> — no onClick handler
  Line 56: <div className="overlay" onClick={closeMenu}> — overlay handler exists
  Line 12: const closeMenu = () => { setIsOpen(false); } — no focus management

> Running acceptance tests (Cypress component tests)...

  Test 1: Close on link click
    Action: Click "Products" link in mobile menu
    Result: Menu remains open. URL changes to /products.
    ❌ FAIL — onClick handler missing on nav links

  Test 2: Close on overlay tap
    Action: Tap the dark backdrop overlay
    Result: Menu closes with slide-out animation.
    ✅ PASS

  Test 3: Smooth animation (200ms)
    Action: Open menu, then close via overlay
    Result: Transition measured at 198ms (±5ms).
    ✅ PASS

  Test 4: Focus return to hamburger
    Action: Close menu, check document.activeElement
    Result: Focus is on <body>. Expected: hamburger button.
    ❌ FAIL — No focus management after close

  Test 5: Viewport resize (mobile→desktop)
    Action: Open menu at 375px width, resize to 1280px
    Result: Menu stays open and overlays desktop content.
    ❌ FAIL — No resize listener to reset state

> Summary: 2/5 criteria PASS, 3 FAIL
  Blockers: onClick missing (AC1), focus management absent (AC4), resize listener absent (AC5)

> Writing qa_report.json...
  overall: FAIL
  additional_issues[0]: critical — Missing onClick on MobileNavLink (MobileNav.tsx)
  additional_issues[1]: error — Focus management missing after close (MobileNav.tsx)
  additional_issues[2]: suggestion — Consider Headless UI Dialog for a11y (MobileNav.tsx)

> Generating qa_feedback.md for implementer...
  Tagged MobileNav.tsx subtasks with [QA CORRECTION] annotations.

[QA COMPLETE] Report written to qa_report.json. Task bounced back to implement phase.
`, '2026-08-12T11:00:00'),
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review'],
  },

  // ═══ AWAITING REVIEW (2) ═══
  {
    id: 'REVIEW-001',
    title: 'Dark Mode Support',
    description: 'Add system-preference-based dark mode with a manual toggle in the user settings.',
    phase: 'awaiting-review',
    spec: '# Dark Mode Support Feature Specification\n\n## Overview\nAdd system-preference-based dark mode with a manual toggle in user settings. All UI components must support both light and dark color schemes using CSS custom properties.\n\n## Acceptance Criteria\n1. All colors use CSS custom properties (var(--color-*)) — no hardcoded color values anywhere\n2. Theme toggle in settings switches between Light, Dark, and System modes\n3. Theme preference persists across page refreshes via localStorage\n4. All 127 components render correctly in dark mode with sufficient contrast\n5. System preference detected via prefers-color-scheme media query on first visit\n\n## Design Decisions\n- Token-based theming: 48 CSS custom properties defined for each theme\n- Persist to localStorage: theme key with values light, dark, or system\n- No flash on load: Theme applied via inline <script> before first paint to avoid FOUC\n- Visual regression: 34 component screenshots validated in dark mode\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Add CSS custom properties for color scheme', acceptance_criteria: ['All colors use var(--color-*) tokens', 'Dark palette defined alongside light'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Implement theme toggle in settings', acceptance_criteria: ['Toggle switches between light/dark/system', 'Preference persists in localStorage'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Update all components to use CSS variables', acceptance_criteria: ['No hardcoded colors remain', 'All components render correctly in dark mode'], depends_on: [1], qa_flagged: false },
      ],
    },
    qaReport: {
      overall: 'PASS',
      criteria: [
        { name: 'CSS custom properties for all colors', status: 'PASS', notes: '48 CSS custom properties defined. All 127 components use var(--color-*) tokens. Zero hardcoded color values found.' },
        { name: 'Theme toggle (light/dark/system)', status: 'PASS', notes: "Toggle component renders correctly with three options. System preference detected via matchMedia('prefers-color-scheme')." },
        { name: 'Preference persists across refresh', status: 'PASS', notes: "localStorage 'theme' key survives page refresh. Inline script prevents flash of unstyled content." },
        { name: 'All components render in dark mode', status: 'PASS', notes: '34/34 component screenshots pass visual regression. Minimum contrast ratio 4.7:1.' },
        { name: 'No hardcoded colors anywhere', status: 'PASS', notes: 'Static analysis: zero color literals in 127 component files. ESLint rule enforced.' },
      ],
      additional_issues: [],
    },
    outputLog: timestampDemoLog(`[QA-REVIEW] Dark Mode Support — Attempt 1
[SESSION] Claude Code v2.4.1 — qa-reviewer persona loaded

> Reading spec.md...
  AC1: All colors use CSS custom properties (var(--color-*))
  AC2: Theme toggle switches between light, dark, and system
  AC3: Preference persists across page refresh (localStorage)
  AC4: All components render correctly in dark mode
  AC5: No hardcoded colors remain in any component

> Reading plan.json for expected implementation scope...
  3 subtasks found, checking completion status via git log...

> Reading src/styles/tokens.css...
  ✓ 48 CSS custom properties defined for light theme
  ✓ 48 matching --dark-* properties in prefers-color-scheme media query
  ✅ All colors use var(--color-*) tokens

> Reading src/components/Settings.tsx...
  ✓ ThemeToggle component with light/dark/system options
  ✓ localStorage persistence with 'theme' key
  ✓ System preference detected via matchMedia('prefers-color-scheme')
  ✅ Toggle works correctly

> Scanning all components for hardcoded colors...
  Scanning 127 component files...
  ✓ 0 hardcoded color values found
  ✅ No color literals remain

> Running visual regression tests (dark mode)...
  Rendering 34 component screenshots in dark mode...

  ✅ ProductCard — all elements visible, correct contrast
  ✅ CheckoutForm — input borders visible, placeholders readable
  ✅ CartSummary — price text white on dark bg (4.7:1 contrast)
  ✅ Navigation — active link highlight visible
  ✅ Modal — overlay opacity correct, content readable
  ... 29 more components all pass

> Summary: 5/5 criteria PASS
  All subtasks completed. No additional issues found.

> Writing qa_report.json...
  overall: PASS
  All acceptance criteria satisfied.
  Visual regression: 34/34 components render correctly in dark mode.

[QA PASS] Task advances to awaiting-review phase.
[MERGE] Creating Pull Request...
[SESSION] Claude Code v2.4.1 — merger persona loaded

> Checking out feature branch: feat/dark-mode-support
> Pushing to origin: feat/dark-mode-support

> Creating PR via GitHub CLI...
  gh pr create --title "feat: Dark Mode Support" --body "
  Adds system-preference-based dark mode with manual toggle.

  Subtasks:
  - CSS custom properties for color scheme (48 tokens)
  - Theme toggle (light/dark/system) with localStorage persistence
  - All 127 components migrated to CSS variables

  QA: All 5 criteria pass. Visual regression: 34/34 components ✓
  "
  ✅ PR #127 created: https://github.com/shopforge/demo/pull/127

> CI checks queued...
  ✓ lint (passed in 42s)
  ✓ typecheck (passed in 18s)
  ✓ unit-tests (passed in 1m 12s)
  ⏳ visual-regression (running...)

[AWAITING REVIEW] PR #127 is open. CI checks: 3/4 passed.
`, '2026-08-25T09:00:00'),
    diff: `diff --git a/src/styles/tokens.css b/src/styles/tokens.css
new file mode 100644
--- /dev/null
+++ b/src/styles/tokens.css
@@ -0,0 +1,48 @@
+:root {
+  --color-bg-primary: #ffffff;
+  --color-bg-secondary: #f8fafc;
+  --color-text-primary: #0f172a;
+  --color-text-secondary: #475569;
+  --color-border: #e2e8f0;
+  --color-accent: #2563eb;
+  --color-success: #16a34a;
+  --color-error: #dc2626;
+}
+[data-theme="dark"] {
+  --color-bg-primary: #0f172a;
+  --color-bg-secondary: #1e293b;
+  --color-text-primary: #f1f5f9;
+  --color-text-secondary: #94a3b8;
+  --color-border: #334155;
+  --color-accent: #3b82f6;
+  --color-card-bg: #1e293b;
+}
diff --git a/src/components/ThemeToggle.tsx b/src/components/ThemeToggle.tsx
new file mode 100644
--- /dev/null
+++ b/src/components/ThemeToggle.tsx
@@ -0,0 +1,45 @@
+'use client';
+import { useEffect, useState } from 'react';
+import { getTheme, setTheme, type Theme } from '@/utils/theme';
+
+export function ThemeToggle() {
+  const [theme, setThemeState] = useState<Theme>('system');
+  const [mounted, setMounted] = useState(false);
+
+  useEffect(() => {
+    setThemeState(getTheme());
+    setMounted(true);
+  }, []);
+
+  return (
+    <div className="theme-toggle" role="radiogroup">
+      {(['light', 'dark', 'system'] as Theme[]).map((t) => (
+        <button key={t} aria-checked={theme === t}
+          onClick={() => { setThemeState(t); setTheme(t); }}>
+          {t === 'light' ? '☀️' : t === 'dark' ? '🌙' : '💻'}
+        </button>
+      ))}
+    </div>
+  );
+}
diff --git a/src/utils/theme.ts b/src/utils/theme.ts
new file mode 100644
--- /dev/null
+++ b/src/utils/theme.ts
@@ -0,0 +1,32 @@
+export type Theme = 'light' | 'dark' | 'system';
+
+const STORAGE_KEY = 'theme';
+
+export function setTheme(theme: Theme): void {
+  const root = document.documentElement;
+  if (theme === 'system') {
+    root.removeAttribute('data-theme');
+  } else {
+    root.setAttribute('data-theme', theme);
+  }
+  localStorage.setItem(STORAGE_KEY, theme);
+}
+
+export function getTheme(): Theme {
+  const stored = localStorage.getItem(STORAGE_KEY);
+  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
+  return 'system';
+}
+
+export function initTheme(): void {
+  const stored = localStorage.getItem(STORAGE_KEY);
+  if (stored === 'light' || stored === 'dark') {
+    document.documentElement.setAttribute('data-theme', stored);
+  }
+}`,
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review'],
  },
  {
    id: 'REVIEW-002',
    title: 'Wishlist with Shareable Links',
    description: 'Users can create wishlists, add products, and share a public link with friends and family.',
    phase: 'awaiting-review',
    outputLog: timestampDemoLog(`[QA-REVIEW] Wishlist with Shareable Links — Attempt 1
[SESSION] Claude Code v2.4.1 — qa-reviewer persona loaded

> Reading spec.md...
  AC1: Users can create, read, update, and delete wishlists
  AC2: Products can be added to and removed from wishlists
  AC3: Each wishlist gets a unique shareable URL (UUID-based)
  AC4: Public share page shows wishlist items in read-only mode
  AC5: Wishlist UI is accessible from account dropdown and product cards

> Reading plan.json for expected implementation scope...
  3 subtasks found, checking completion status via git log...

> Running API integration tests...

  Test 1: Wishlist CRUD
    POST /api/wishlists → 201 { id: "wl_a3f8...", name: "Birthday" }
    GET /api/wishlists → 200 [{ id: "wl_a3f8...", name: "Birthday", items: [...] }]
    PUT /api/wishlists/wl_a3f8 → 200 { name: "Birthday 2026" }
    DELETE /api/wishlists/wl_a3f8 → 204
    ✅ PASS — Full CRUD lifecycle works

  Test 2: Product add/remove
    POST /api/wishlists/wl_b4e2/items → 201 { productId: "prod_001" }
    DELETE /api/wishlists/wl_b4e2/items/prod_001 → 204
    ✅ PASS — Add and remove work correctly

  Test 3: Shareable public link
    GET /wishlist/wl_b4e2?share=a9f2c8d1...
    Response: 200, renders wishlist in read-only mode
    No edit/delete buttons visible
    No authentication required for public link
    ✅ PASS — Public share page works, no auth leaks

  Test 4: Account UI integration
    /account dropdown shows "My Wishlists (2)"
    Clicking navigates to /account/wishlists
    Product cards show ❤️ "Add to Wishlist" button
    ✅ PASS — UI integration complete

> Summary: 5/5 criteria PASS
  All subtasks completed. No issues found.

> Writing qa_report.json...
  overall: PASS
  All acceptance criteria satisfied.

[QA PASS] Task advances to awaiting-review phase.
[MERGE] Creating Pull Request...
[SESSION] Claude Code v2.4.1 — merger persona loaded

> Checking out feature branch: feat/wishlist-shareable-links
> Pushing to origin: feat/wishlist-shareable-links

> Creating PR via GitHub CLI...
  gh pr create --title "feat: Wishlist with Shareable Links" --body "
  Users can create wishlists, add products, and share via public UUID links.

  Subtasks:
  - Wishlist CRUD API (create, read, update, delete)
  - Shareable public link with read-only view
  - Account dropdown and product card UI integration

  QA: All 5 criteria pass. API tests: 4/4 ✓
  "
  ✅ PR #129 created: https://github.com/shopforge/demo/pull/129

> CI checks queued...
  ✓ lint (passed in 38s)
  ✓ typecheck (passed in 21s)
  ✓ unit-tests (passed in 1m 04s)
  ⏳ e2e-tests (running...)

[AWAITING REVIEW] PR #129 is open. CI checks: 3/4 passed.
`, '2026-08-26T10:00:00'),
    plan: {
      subtasks: [
        { id: 1, title: 'Wishlist CRUD API', acceptance_criteria: ['Create/read/update/delete wishlists', 'Add/remove products from wishlist'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Shareable public link', acceptance_criteria: ['Each wishlist gets a unique UUID-based URL', 'Public page shows wishlist items in read-only mode'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Wishlist UI in account area', acceptance_criteria: ['List of wishlists in account dropdown', 'Add-to-wishlist button on product cards'], depends_on: [1], qa_flagged: false },
      ],
    },
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review'],
  },

  // ═══ PR OPEN (1) — the review-column showcase ticket ═══
  // phase 'pr-open' normalises into the Review column and renders as the
  // 'PR Open' status badge. It carries one fake log per agent role plus the
  // orchestrator log, so the task's Terminal tab shows every role filter:
  //   output.log       → Orchestrator   output-qa.log    → QA Review
  //   output-spec.log  → Spec (Analyst) output-merge.log → Merge (Merger)
  //   output-plan.log  → Plan (Planner) output-st{1,2}.log → Coder
  {
    id: 'PR-OPEN-001',
    title: 'Promo Code Stacking Rules',
    description: 'Define and enforce how multiple promo codes combine: at most one percentage code plus one fixed-amount code per order, and never two codes that both discount shipping.',
    phase: 'pr-open',
    prUrl: 'https://github.com/shopforge/shopforge/pull/137',
    mergeStrategy: 'pull-request',
    spec: '# Promo Code Stacking Rules\n\n## Overview\nCustomers can currently apply unlimited promo codes, and the discounts compound without limit. Define a stacking policy, enforce it at cart validation time, and surface a clear reason when a code is rejected.\n\n## Acceptance Criteria\n1. At most one percentage code and one fixed-amount code may apply to an order\n2. Two shipping-discount codes cannot stack\n3. Applying a code that breaks the policy is rejected with a reason naming the conflict\n4. Discount order is fixed: percentage first, then fixed amount, then shipping\n5. Total discount never exceeds the order subtotal\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Implement the stacking policy in cart validation', acceptance_criteria: ['One percentage + one fixed-amount code maximum', 'Reject a second shipping-discount code', 'Rejection carries a reason naming the conflicting code'], depends_on: [], qa_flagged: false, completed: true },
        { id: 2, title: 'Apply discounts in a fixed order and clamp to subtotal', acceptance_criteria: ['Percentage applies before fixed amount', 'Shipping discounts apply last', 'Total discount never exceeds the subtotal'], depends_on: [1], qa_flagged: false, completed: true },
      ],
    },
    qaReport: {
      overall: 'PASS',
      criteria: [
        { name: 'One percentage + one fixed-amount code', status: 'PASS', notes: 'A third code is rejected with the conflicting code named in the response.' },
        { name: 'Shipping discounts cannot stack', status: 'PASS', notes: 'Second shipping code rejected; verified with two free-shipping codes.' },
        { name: 'Rejection names the conflict', status: 'PASS', notes: 'Error payload includes the conflicting code and the policy rule.' },
        { name: 'Fixed discount order', status: 'PASS', notes: 'Percentage, then fixed amount, then shipping — asserted in 14 tests.' },
        { name: 'Discount clamped to subtotal', status: 'PASS', notes: 'Total discount caps at the subtotal; total never goes negative.' },
      ],
      additional_issues: [],
    },
    outputLog: `[2026-09-23T09:12:00] [ORCHESTRATOR] Promo Code Stacking Rules

[2026-09-23T09:12:04] Task started from backlog — start phase: spec
[2026-09-23T09:12:05] Session created: analyst (spec) — worktree .worktrees/promo-code-stacking-rules
[2026-09-23T09:19:41] Phase 'spec' complete — spec.md + spec_summary.md written
[2026-09-23T09:19:42] Advanced to 'plan'
[2026-09-23T09:24:10] Phase 'plan' complete — plan.json with 2 subtasks
[2026-09-23T09:24:11] Advanced to 'implement'
[2026-09-23T09:52:33] Subtask 1 completed (34m 22s)
[2026-09-23T10:19:08] Subtask 2 completed (26m 35s)
[2026-09-23T10:19:09] All subtasks complete — advancing to 'qa-review'
[2026-09-23T10:31:55] QA PASS — 5/5 criteria, no additional issues
[2026-09-23T10:31:56] Advanced to 'awaiting-review'
[2026-09-23T10:44:02] Merge strategy selected: pull-request
[2026-09-23T10:44:31] Phase 'create-pr' complete — PR #137 opened
[2026-09-23T10:44:31] CI checks queued: lint, typecheck, unit-tests, integration-tests
[2026-09-23T11:16:20] CI checks: 3 passed, integration-tests still running
[2026-09-23T11:16:20] Phase 'pr-open' — paused for human review
`,
    roleLogs: {
      'output-spec.log': `[2026-09-23T09:12:08] Session started — role: analyst
[2026-09-23T09:12:09] > Reading the request...
[2026-09-23T09:12:11]   "Define how multiple promo codes combine"
[2026-09-23T09:12:12] > Scanning src/cart/* and src/promotions/* for the current discount model
[2026-09-23T09:12:31]   src/promotions/apply.ts — applies every code in insertion order
[2026-09-23T09:12:31]   No policy module exists. Discounts compound with no ceiling.
[2026-09-23T09:13:02] > Checking how shipping discounts are represented
[2026-09-23T09:13:14]   DiscountKind = 'percentage' | 'fixed' | 'shipping'
[2026-09-23T09:13:40] > Decision: the policy lives in one module — src/promotions/policy.ts
[2026-09-23T09:14:02] - - Discarding two designs before settling:
[2026-09-23T09:14:02] - - a) per-code eligibility flags → the caller still has to know the rules
[2026-09-23T09:14:03] - - b) reject every code after the first → breaks the fixed+percentage case
[2026-09-23T09:14:03] - - Accepted: category counting (percentage | fixed | shipping) with fixed application order
[2026-09-23T09:15:20] > Writing acceptance criteria with concrete values
[2026-09-23T09:16:44]   Ordering: percentage → fixed → shipping (decision, not deferred to the engineer)
[2026-09-23T09:16:45]   Clamp: total discount <= subtotal, never negative
[2026-09-23T09:17:30] > Writing spec.md
[2026-09-23T09:19:38] > Writing spec_summary.md (spec decisions only, unbounded spec kept out of the PR body)
[2026-09-23T09:19:41] Spec complete — 5 acceptance criteria, all with concrete values
`,
      'output-plan.log': `[2026-09-23T09:19:45] Session started — role: planner
[2026-09-23T09:19:46] > Reading spec.md (5 acceptance criteria)
[2026-09-23T09:19:52] > Reading src/promotions/apply.ts to size the change
[2026-09-23T09:20:30]   apply.ts: 84 lines, no tests. src/cart/validate.ts calls it in one place.
[2026-09-23T09:20:45] > Deciding subtask boundaries
[2026-09-23T09:21:02]   Subtask 1: policy + rejection reasons (ACs 1-3)
[2026-09-23T09:21:02]   Subtask 2: deterministic ordering + clamping (ACs 4-5)
[2026-09-23T09:22:18]   Both touch src/promotions/apply.ts — serialised with depends_on: [1]
[2026-09-23T09:23:40] > Writing plan.json
[2026-09-23T09:24:08]   2 subtasks, 6 acceptance criteria mapped, no orphaned spec criteria
[2026-09-23T09:24:10] Plan complete
`,
      'output-st1.log': `[2026-09-23T09:24:14] Session started — role: coder (subtask 1/2)
[2026-09-23T09:24:15] > Reading plan.json for subtask 1 scope
[2026-09-23T09:24:20] > Creating src/promotions/policy.ts
[2026-09-23T09:24:21]   export type DiscountKind = 'percentage' | 'fixed' | 'shipping';
[2026-09-23T09:24:21] + MAX_PER_KIND: Record<DiscountKind, number> = { percentage: 1, fixed: 1, shipping: 1 }
[2026-09-23T09:24:22] + export function conflictFor(codes, next): string | null
[2026-09-23T09:24:22] + export function validateStack(codes): { ok: true } | { ok: false; conflict: string }
[2026-09-23T09:25:47] > Editing src/cart/validate.ts
[2026-09-23T09:25:49] + calls validateStack() before pricing and returns the conflict reason
[2026-09-23T09:26:01] > Writing src/promotions/policy.test.ts
[2026-09-23T09:33:12]   ✓ allows one percentage + one fixed code (4ms)
[2026-09-23T09:33:12]   ✓ rejects a second percentage code (2ms)
[2026-09-23T09:33:12]   ✓ rejects two shipping codes (2ms)
[2026-09-23T09:33:13]   ✓ names the conflicting code in the rejection (3ms)
[2026-09-23T09:34:02] > Running typecheck: npx tsc --noEmit
[2026-09-23T09:34:20]   No type errors
[2026-09-23T09:35:44] > Running the cart suite: npx vitest run src/cart
[2026-09-23T09:36:31]   41 passed
[2026-09-23T09:36:52] > Committing subtask 1
[2026-09-23T09:52:33] Subtask 1 complete — drift check: only src/promotions/* and src/cart/validate.ts touched
`,
      'output-st2.log': `[2026-09-23T09:52:36] Session started — role: coder (subtask 2/2)
[2026-09-23T09:52:37] > Reading plan.json for subtask 2 scope
[2026-09-23T09:52:41] > Editing src/promotions/apply.ts
[2026-09-23T09:52:43] + APPLY_ORDER: DiscountKind[] = ['percentage', 'fixed', 'shipping']
[2026-09-23T09:52:43] + discounts are now summed per kind, then applied in APPLY_ORDER
[2026-09-23T09:53:20] + clamp: totalDiscount = Math.min(totalDiscount, subtotal)
[2026-09-23T09:53:21]   - removed the insertion-order loop that let discounts compound
[2026-09-23T09:54:08] > Extending src/promotions/apply.test.ts
[2026-09-23T10:01:55]   ✓ percentage applies before fixed amount (3ms)
[2026-09-23T10:01:55]   ✓ shipping discount applies last (2ms)
[2026-09-23T10:01:56]   ✓ total discount clamps to subtotal (2ms)
[2026-09-23T10:01:56]   ✓ 100% discount yields a zero total, never negative (2ms)
[2026-09-23T10:02:40] > Running typecheck: npx tsc --noEmit
[2026-09-23T10:02:58]   No type errors
[2026-09-23T10:03:21] > Running the full suite: npx vitest run
[2026-09-23T10:05:47]   612 passed
[2026-09-23T10:06:12] > Writing implementation_summary.md
[2026-09-23T10:06:40] > Committing subtask 2
[2026-09-23T10:19:08] Subtask 2 complete — 2 files changed, no out-of-scope edits
`,
      'output-qa.log': `[2026-09-23T10:19:12] Session started — role: qa-reviewer
[2026-09-23T10:19:13] > Reading spec.md (5 acceptance criteria)
[2026-09-23T10:19:31] > Reading plan.json — 2/2 subtasks reported complete
[2026-09-23T10:19:48] > Checking committed history against the plan
[2026-09-23T10:19:50]   Only src/promotions/* and src/cart/validate.ts changed — matches both subtask scopes
[2026-09-23T10:20:31] > AC1 — one percentage + one fixed-amount code maximum
[2026-09-23T10:20:44]   POST /api/cart/promo with SAVE20 + 5OFF   → 200, both applied
[2026-09-23T10:20:52]   POST /api/cart/promo with SAVE20 + EXTRA10 → 409, conflict: EXTRA10
[2026-09-23T10:20:52]   PASS
[2026-09-23T10:21:19] > AC2 — two shipping-discount codes cannot stack
[2026-09-23T10:21:31]   FREESHIP + SHIPFREE → 409, conflict: SHIPFREE
[2026-09-23T10:21:31]   PASS
[2026-09-23T10:22:05] > AC3 — rejection names the conflict
[2026-09-23T10:22:18]   Error payload: { code: 'PROMO_STACK_CONFLICT', conflict: 'EXTRA10', rule: 'one-percent-per-order' }
[2026-09-23T10:22:18]   PASS
[2026-09-23T10:22:44] > AC4 — fixed discount order
[2026-09-23T10:23:02]   Subtotal 100.00, SAVE20 then 5OFF → 75.00 (20% first, then 5.00)
[2026-09-23T10:23:19]   Reversed input order gives the same 75.00  →  order-independent
[2026-09-23T10:23:19]   PASS
[2026-09-23T10:23:40] > AC5 — discount never exceeds the subtotal
[2026-09-23T10:23:58]   Subtotal 5.00 with 50OFF + 100PERCENT → total 0.00, never negative
[2026-09-23T10:23:58]   PASS
[2026-09-23T10:24:30] > Additional checks
[2026-09-23T10:24:41]   Existing cart suite: 41 passed, no regressions
[2026-09-23T10:25:02]   No skipped or focused tests in the new files
[2026-09-23T10:26:15] > Writing qa_report.json
[2026-09-23T10:31:53]   5/5 criteria PASS — no additional issues
[2026-09-23T10:31:55] QA PASS
`,
      'output-merge.log': `[2026-09-23T10:44:05] Session started — role: merger
[2026-09-23T10:44:06] > Merge strategy: pull-request
[2026-09-23T10:44:08] > Checking out branch: feat/promo-code-stacking-rules
[2026-09-23T10:44:11] > Syncing with origin/main
[2026-09-23T10:44:14]   Already up to date — no conflicts
[2026-09-23T10:44:17] > Squashing 2 subtask commits into one ticket commit
[2026-09-23T10:44:22]   feat: Promo Code Stacking Rules
[2026-09-23T10:44:24] > Pushing branch to origin
[2026-09-23T10:44:29] > Creating the PR via the GitHub CLI
[2026-09-23T10:44:31]   PR #137 created — https://github.com/shopforge/shopforge/pull/137
[2026-09-23T10:44:31]   Body includes the specification summary and the QA result
[2026-09-23T10:44:33] Handing back to the orchestrator — CI polling starts
`,
    },
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'pr-open'],
  },

  // ═══ AWAITING REVIEW — parked by a failure (1) ═══
  // Not a QA pass: a no-op spec revision landed here. The reason below drives
  // the 'Needs attention' banner in the review panel and the icon-only badge
  // on the kanban card, so the Diagnostics section has something to show.
  {
    id: 'PARK-001',
    title: 'Tax Rules for EU Countries',
    description: 'Apply per-country VAT rates at checkout for EU destinations, with a breakdown line on the receipt.',
    phase: 'awaiting-review',
    awaitingReviewReason: 'No-op spec revision — the analyst session completed without changing spec.md (still identical to spec_revision_before.md). This round\'s feedback was not addressed. This is not a QA pass; reject back to the analyst to retry.',
    spec: '# EU Tax Rules\n\n## Acceptance Criteria\n1. VAT rate is resolved from the destination country\n2. Receipt shows a tax breakdown line per rate\n3. B2B orders with a valid VAT ID are zero-rated\n4. Prices displayed include VAT for EU destinations\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Country → VAT rate table', acceptance_criteria: ['Every EU member state has a rate', 'Unknown destinations fall back to the standard rate'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'VAT breakdown on the receipt', acceptance_criteria: ['One line per applied rate', 'Rates shown to two decimals'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Zero-rate B2B orders with a valid VAT ID', acceptance_criteria: ['VAT ID is validated against the VIES service', 'Invalid VAT IDs keep the standard rate'], depends_on: [1], qa_flagged: false },
      ],
    },
    outputLog: `[2026-09-24T14:02:10] [ORCHESTRATOR] Tax Rules for EU Countries

[2026-09-24T14:02:11] Review feedback received — routing to the analyst (spec revision)
[2026-09-24T14:02:12] spec.md snapshotted to spec_revision_before.md
[2026-09-24T14:02:13] Restarting from 'spec' — downstream QA artifacts cleared, plan.json preserved
[2026-09-24T14:02:14] Session created: analyst (spec revision)
[2026-09-24T14:31:40] Spec revision session ended — spec.md is byte-identical to spec_revision_before.md
[2026-09-24T14:31:41] Parked at 'awaiting-review' (no-op revision) — human decision required
`,
    roleLogs: {
      'output-spec.log': `[2026-09-24T14:02:18] Session started — role: analyst (revision mode)
[2026-09-24T14:02:19] > Reading spec_revision_feedback.md
[2026-09-24T14:02:21]   "The VAT-ID validation is underspecified: name the service, the failure mode
[2026-09-24T14:02:21]    and what happens to an order whose VAT ID cannot be verified."
[2026-09-24T14:02:24] > Reading the existing spec.md (4 acceptance criteria)
[2026-09-24T14:03:02] > Investigating how VAT IDs are validated today
[2026-09-24T14:03:40]   src/tax/vat.ts — calls the VIES SOAP endpoint, no timeout, no retry
[2026-09-24T14:04:11]   No test covers an unreachable VIES instance
[2026-09-24T14:05:48] > Deciding the failure mode
[2026-09-24T14:05:49]   - - Rejected: treat an unreachable VIES as valid → silently zero-rates bad orders
[2026-09-24T14:05:50]   - - Rejected: reject the order entirely → loses revenue on a vendor outage
[2026-09-24T14:05:50]   - - Accepted: 3s timeout, apply the standard rate, flag the order for later re-validation
[2026-09-24T14:06:31] > Drafting the revised acceptance criteria
[2026-09-24T14:06:33]   AC3 … validated against VIES with a 3 second timeout
[2026-09-24T14:06:34]   AC4 … an unverifiable VAT ID is charged the standard rate and flagged for re-validation
[2026-09-24T14:06:35]   AC5 … the flag surfaces in the finance export
[2026-09-24T14:07:02] > Session budget reached while verifying the draft diff
[2026-09-24T14:07:02]   Drafted criteria were never written back to spec.md
[2026-09-24T14:31:38] Session ended — spec.md unchanged
`,
    },
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'spec', 'awaiting-review'],
  },

  // ═══ DONE (1) ═══
  {
    id: 'DONE-001',
    title: 'Order Tracking Dashboard',
    description: 'Real-time order tracking with map view showing the package\'s current location and estimated delivery window.',
    phase: 'done',
    outputLog: timestampDemoLog(`[QA-REVIEW] Order Tracking Dashboard — Attempt 1
[SESSION] Claude Code v2.4.1 — qa-reviewer persona loaded

> Reading spec.md...
  AC1: Map shows package location with a pin
  AC2: Status timeline (5 steps) with current step highlighted
  AC3: Estimated delivery window updates dynamically
  AC4: Push notification when status changes
  AC5: Tracking number is clickable and opens carrier's tracking page

> Reading plan.json for expected implementation scope...
  4 subtasks found, checking completion status via git log...

> Running acceptance tests...

  Test 1: Map with package pin
    Mapbox map renders at 600x400
    Package pin at [37.7749, -122.4194]
    Pin updates when location changes (simulated)
    ✅ PASS

  Test 2: Status timeline
    5 steps rendered: Ordered → Processing → Shipped → Out for Delivery → Delivered
    Current step ("Shipped") highlighted in blue
    Completed steps ("Ordered", "Processing") show ✓ checkmark
    ✅ PASS

  Test 3: Delivery ETA estimation
    Carrier API returns: { estimated: "2026-07-09 14:30", confidence: 0.92 }
    UI shows: "Estimated delivery: July 9, 2:30 PM"
    ETA refreshes on page load and every 30 minutes
    ✅ PASS

  Test 4: Push notifications
    Web Push API subscription works
    Notification payload: { title: "Package Shipped!", body: "Your order #OF-4821 is on its way" }
    Clicking notification navigates to /orders/OF-4821/tracking
    ✅ PASS

  Test 5: Carrier tracking link
    UPS tracking number "1Z999AA10123456784" renders as link
    href="https://www.ups.com/track?tracknum=1Z999AA10123456784"
    ✅ PASS

> Summary: 5/5 criteria PASS
  All subtasks completed. No issues found.

> Writing qa_report.json...
  overall: PASS
  All acceptance criteria satisfied.

[QA PASS] Task advances to awaiting-review phase.
[MERGE] Creating Pull Request...
[SESSION] Claude Code v2.4.1 — merger persona loaded

> Checking out feature branch: feat/order-tracking-dashboard
> Pushing to origin: feat/order-tracking-dashboard

> Creating PR via GitHub CLI...
  gh pr create --title "feat: Order Tracking Dashboard" --body "
  Real-time order tracking with Mapbox map, status timeline, and push notifications.

  Subtasks:
  - Mapbox integration with live package location pin
  - 5-step status timeline (Ordered→Processing→Shipped→Out for Delivery→Delivered)
  - Dynamic ETA from carrier API
  - Web Push notifications on status change

  QA: All 5 criteria pass.
  "
  ✅ PR #124 created: https://github.com/shopforge/demo/pull/124

> CI checks queued...
  ✓ lint (passed in 45s)
  ✓ typecheck (passed in 16s)
  ✓ unit-tests (passed in 1m 22s)
  ✓ visual-regression (passed in 2m 38s)
  ✅ All CI checks passed!

> Merging PR #124 via gh pr merge --merge...
  ✅ PR #124 merged into master

> git push origin master --follow-tags
  ✅ Pushed to origin/master

> git branch -d feat/order-tracking-dashboard
  ✅ Feature branch cleaned up

[DONE] All 4 subtasks complete. Mapbox integration with live tracking, 5-step timeline, dynamic ETA from carrier API, and push notifications via Web Push API. All tests pass.
`, '2026-07-09T14:00:00'),
    spec: '# Order Tracking Dashboard\n\n## Acceptance Criteria\n1. Map shows package location with a pin\n2. Status timeline shows: Order Placed → Processing → Shipped → Out for Delivery → Delivered\n3. Estimated delivery window updates dynamically\n4. Push notification when status changes\n5. Tracking number is clickable and opens carrier\'s tracking page\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Integrate map component (Mapbox)', acceptance_criteria: ['Map renders with package location pin', 'Pin updates when location changes'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Build status timeline component', acceptance_criteria: ['5-step timeline with current step highlighted', 'Completed steps show checkmark'], depends_on: [], qa_flagged: false },
        { id: 3, title: 'Delivery ETA estimation', acceptance_criteria: ['ETA updates based on carrier API', 'Shows "Delivered" when package arrives'], depends_on: [1], qa_flagged: false },
        { id: 4, title: 'Push notification integration', acceptance_criteria: ['User receives notification on status change', 'Notification links to tracking page'], depends_on: [3], qa_flagged: false },
      ],
    },
    prUrl: 'https://github.com/shopforge/shopforge/pull/124',
    mergeStrategy: 'pull-request',
    completionSummary: 'All 4 subtasks complete. Mapbox integration with live tracking, 5-step timeline, dynamic ETA from carrier API, and push notifications via Web Push API. All tests pass.',
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'done'],
  },

  // ═══ DONE (2 more) ═══
  // Disk DONE tasks render as ordinary cards with the green 'PR' link, on top
  // of the history-reconstructed ones the DONE column appends underneath
  // (see seedGitHistory at the bottom of this script).
  {
    id: 'DONE-002',
    title: 'Guest Checkout Without Account Creation',
    description: 'Let shoppers complete an order without registering. Collect only the email needed for the receipt and offer account creation afterwards.',
    phase: 'done',
    prUrl: 'https://github.com/shopforge/shopforge/pull/131',
    mergeStrategy: 'pull-request',
    completionSummary: 'Guest checkout shipped. 6/6 acceptance criteria pass, 12 new integration tests, no regressions in the existing auth flow.',
    spec: '# Guest Checkout\n\n## Acceptance Criteria\n1. Cart and checkout are reachable without an account\n2. Only email is required at checkout\n3. Receipt is emailed to the address used\n4. Account creation is offered on the confirmation page\n5. An existing account with that email is detected and linked\n6. No customer record is created until the order is placed\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Relax checkout route guards for anonymous sessions', acceptance_criteria: ['Cart and checkout render without a session', 'Order POST accepts an anonymous session'], depends_on: [], qa_flagged: false, completed: true },
        { id: 2, title: 'Email-only checkout form', acceptance_criteria: ['Only email is required', 'Field is validated and normalised to lowercase'], depends_on: [1], qa_flagged: false, completed: true },
        { id: 3, title: 'Link an existing account by email at order time', acceptance_criteria: ['Existing account is detected', 'Order is attached to it', 'No duplicate customer record is created'], depends_on: [2], qa_flagged: false, completed: true },
      ],
    },
    qaReport: {
      overall: 'PASS',
      criteria: [
        { name: 'Reachable without an account', status: 'PASS', notes: 'Cart, checkout and confirmation all render for anonymous sessions.' },
        { name: 'Only email required', status: 'PASS', notes: 'Form submits with email alone; all other fields are optional.' },
        { name: 'Receipt emailed', status: 'PASS', notes: 'Receipt delivered to the checkout address in the sandbox mailer.' },
        { name: 'Account offered afterwards', status: 'PASS', notes: 'Confirmation page shows the create-account prompt.' },
        { name: 'Existing account linked', status: 'PASS', notes: 'Order attaches to the existing customer instead of creating a duplicate.' },
        { name: 'No premature customer record', status: 'PASS', notes: 'Customer row is only written on successful order placement.' },
      ],
      additional_issues: [],
    },
    outputLog: `[2026-08-19T09:12:00] [ORCHESTRATOR] Guest Checkout Without Account Creation

[2026-08-19T09:12:04] Phase 'create-pr' complete — PR #131 opened
[2026-08-19T09:12:04] CI checks queued: lint, typecheck, unit-tests, integration-tests
[2026-08-19T09:41:37] All 4 checks passed in 29m 33s
[2026-08-19T09:41:38] Merged PR #131 into main — task marked done
`,
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'done'],
  },
  {
    id: 'DONE-003',
    title: 'Fix Cart Total Rounding at Checkout',
    description: 'Line-item totals are summed as floats, so a cart of $19.99 + $0.01 + $0.01 charges $20.009999. Round once, at the end, in minor units.',
    phase: 'done',
    prUrl: 'https://github.com/shopforge/shopforge/pull/133',
    mergeStrategy: 'pull-request',
    completionSummary: 'Totals are computed in integer cents. Added a 200-case property test asserting the displayed total always equals the charged total.',
    spec: '# Cart Total Rounding\n\n## Acceptance Criteria\n1. Cart total equals the sum of line items to the cent\n2. No floating-point residue in any displayed or charged amount\n3. Tax is computed on the rounded subtotal\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Move money arithmetic to integer minor units', acceptance_criteria: ['All totals are integer cents internally', 'Displayed values format from minor units'], depends_on: [], qa_flagged: false, completed: true },
        { id: 2, title: 'Property test: displayed total equals charged total', acceptance_criteria: ['200 generated carts assert display == charge', 'Boundary cases with 0, 1 and 10,000 line items covered'], depends_on: [1], qa_flagged: false, completed: true },
      ],
    },
    qaReport: {
      overall: 'PASS',
      criteria: [
        { name: 'Total equals sum to the cent', status: 'PASS', notes: 'Integer minor units throughout; 0 drift across 200 generated carts.' },
        { name: 'No float residue', status: 'PASS', notes: 'Grepped for parseFloat in the money path — only the boundary formatter remains.' },
        { name: 'Tax on rounded subtotal', status: 'PASS', notes: 'Tax is applied after subtotal rounding, matching the spec.' },
      ],
      additional_issues: [],
    },
    outputLog: `[2026-08-28T15:03:15] [ORCHESTRATOR] Fix Cart Total Rounding at Checkout

[2026-08-28T15:03:19] Phase 'create-pr' complete — PR #133 opened
[2026-08-28T15:31:52] All 4 checks passed in 28m 33s
[2026-08-28T15:31:53] Merged PR #133 into main — task marked done
`,
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'done'],
  },

  // ═══ FAILED (1) ═══
  {
    id: 'FAIL-001',
    title: 'Fix Checkout Timeout Under High Load (500+ Concurrent Users)',
    description: 'Checkout API times out (>5s) when more than 500 users are checking out simultaneously. Need to optimize the payment processing pipeline.',
    phase: 'failed',
    spec: '# Checkout Timeout Fix\n\n## Acceptance Criteria\n1. P95 checkout latency under 2 seconds at 500 concurrent users\n2. No 5xx errors during load test\n3. Payment gateway timeout set to 3 seconds with graceful fallback\n4. Redis connection pool increased to handle burst traffic\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Profile checkout hot path', acceptance_criteria: ['Identify slowest operations via flame graph', 'Document top 3 bottlenecks'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Optimize payment gateway calls', acceptance_criteria: ['Implement request batching for Stripe API calls', 'Add 3s timeout with circuit breaker'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Increase Redis connection pool', acceptance_criteria: ['Pool size: 50 connections (up from 10)', 'Connection retry with exponential backoff'], depends_on: [], qa_flagged: false },
        { id: 4, title: 'Run load test at 500 concurrent users', acceptance_criteria: ['P95 under 2 seconds post-fix', 'Zero 5xx errors during 5-minute test'], depends_on: [2, 3], qa_flagged: false },
      ],
    },
    qaReport: {
      overall: 'FAIL',
      criteria: [
        { name: 'P95 under 2s at 500 users', status: 'FAIL', notes: 'P95 is 4.2s — circuit breaker works but Redis pool is still at default size' },
        { name: 'No 5xx errors', status: 'FAIL', notes: '12 502 errors during 5-minute load test' },
        { name: 'Payment gateway timeout', status: 'PASS', notes: '3s timeout with circuit breaker implemented correctly' },
        { name: 'Redis connection pool', status: 'FAIL', notes: 'Pool is still 10 connections, not the 50 required by the spec' },
      ],
      additional_issues: [
        { severity: 'critical', description: 'Redis connection pool configuration not applied — still using default 10 connections', file: 'src/config/redis.ts' },
        { severity: 'error', description: 'Load test reveals Webhook callback isn\'t retried on failure, causing 502s under load', file: 'src/checkout/webhook.ts' },
      ],
    },
    completionSummary: 'Circuit breaker implemented but Redis pool and webhook retry remain unfixed after 3 QA attempts.',
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'failed'],
  },
];

// ── Roadmap ─────────────────────────────────────────────────────────

const ROADMAP = {
  generated_at: '2026-07-06T12:00:00.000Z',
  executive_summary: 'ShopForge is building a competitive mid-market e-commerce platform. The next 6 months focus on conversion rate optimization and international expansion.',
  competitor_analysis_run: true,   competitors: ['Shopify Plus', 'BigCommerce', 'WooCommerce', 'Magento'],
  phases: {
    now: [
      { title: 'Abandoned Cart Email Recovery', priority: 'P0', complexity: 'Medium', category: 'Conversion', description: 'Automated 3-email sequence for abandoned carts with progressive discounts', affected_files: ['src/email/*', 'src/cart/*'], source: 'internal' },
      { title: 'Checkout Performance at Scale', priority: 'P0', complexity: 'High', category: 'Performance', description: 'Resolve timeout issues under 500+ concurrent users', affected_files: ['src/checkout/*', 'src/config/redis.ts'], source: 'internal' },
      { title: 'Dark Mode Support', priority: 'P1', complexity: 'Medium', category: 'UI/UX', description: 'System-preference dark mode with manual toggle', affected_files: ['src/styles/*', 'src/components/*'], source: 'internal' },
      { title: 'Mobile Navigation Fixes', priority: 'P1', complexity: 'Low', category: 'Mobile', description: 'Auto-close menu, focus management, viewport resize handling', affected_files: ['src/components/MobileNav.tsx'], source: 'internal' },
    ],
    next: [
      { title: 'BNPL Integration (Klarna / Affirm)', priority: 'P1', complexity: 'High', category: 'Payments', description: 'Buy Now Pay Later options to increase average order value', affected_files: ['src/payments/*'], source: 'internal' },
      { title: 'Customer Reviews with Photos', priority: 'P2', complexity: 'Medium', category: 'Social Proof', description: 'Star ratings, written reviews, and photo uploads from verified purchasers', affected_files: ['src/reviews/*'], source: 'internal' },
      { title: 'One-Click Reorder', priority: 'P2', complexity: 'Low', category: 'Retention', description: 'Reorder previous purchases with saved payment and shipping', affected_files: ['src/orders/*'], source: 'internal' },
      { title: 'Wishlist with Shareable Links', priority: 'P2', complexity: 'Medium', category: 'Social', description: 'Create wishlists and share public links with friends', affected_files: ['src/wishlist/*'], source: 'internal' },
    ],
    later: [
      { title: 'Multi-Currency Checkout', priority: 'P3', complexity: 'High', category: 'International', description: 'Real-time exchange rates and local currency display', affected_files: ['src/checkout/*', 'src/pricing/*'], source: 'internal' },
      { title: 'Product Recommendation Engine', priority: 'P3', complexity: 'High', category: 'Personalization', description: 'ML-based product recommendations from browsing and purchase history', affected_files: ['src/recommendations/*'], source: 'internal' },
      { title: 'Shipping Rate Calculator', priority: 'P3', complexity: 'Medium', category: 'Logistics', description: 'Dynamic rates based on weight, dimensions, and delivery zone', affected_files: ['src/shipping/*'], source: 'internal' },
      { title: 'Inventory Alert System', priority: 'P4', complexity: 'Medium', category: 'Operations', description: 'Real-time stock tracking with low-stock alerts', affected_files: ['src/inventory/*'], source: 'internal' },
    ],
    icebox: [
      { title: 'Search with Semantic Matching', priority: 'P4', complexity: 'High', category: 'Search', description: 'Vector-based semantic search beyond keyword matching', affected_files: ['src/search/*'], source: 'competitor_analysis' },
      { title: 'AI-Powered Product Descriptions', priority: 'P5', complexity: 'Medium', category: 'Content', description: 'Auto-generate product descriptions from attributes and images', affected_files: ['src/products/*'], source: 'ideation' },
    ],
  },
};

// ── Write helpers ───────────────────────────────────────────────────

type AgentRole = 'analyst' | 'planner' | 'coder' | 'qa' | 'merge';

const AGENT_ROLE_INDEX: Record<AgentRole, number> = {
  analyst: 0,
  planner: 1,
  coder: 2,
  qa: 3,
  merge: 4,
};

function phaseAgentRoles(task: SeedTask): AgentRole[] {
  const rolesThroughPhase: Record<string, AgentRole[]> = {
    backlog: [],
    spec: ['analyst'],
    plan: ['analyst', 'planner'],
    implement: ['analyst', 'planner', 'coder'],
    'qa-review': ['analyst', 'planner', 'coder', 'qa'],
    'awaiting-review': ['analyst', 'planner', 'coder', 'qa'],
    'pr-open': ['analyst', 'planner', 'coder', 'qa', 'merge'],
    done: ['analyst', 'planner', 'coder', 'qa', 'merge'],
    // Keep the Merger role visible on failed tickets too: this is demo-only
    // role coverage, and the generated message explicitly says no merge ran.
    failed: ['analyst', 'planner', 'coder', 'qa', 'merge'],
  };
  const roles = [...(rolesThroughPhase[task.phase] ?? [])];
  if (task.phase === 'awaiting-review' && (task.prUrl || task.outputLog?.includes('[MERGE]'))) {
    roles.push('merge');
  }
  return roles;
}

function roleForTranscriptLine(line: string): AgentRole | 'orchestrator' | null {
  const body = line.replace(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\] /, '');
  if (body.startsWith('[IMPLEMENT]')) return 'coder';
  if (body.startsWith('[QA-REVIEW]')) return 'qa';
  if (body.startsWith('[MERGE]')) return 'merge';
  if (body.startsWith('[ORCHESTRATOR]')) return 'orchestrator';
  return null;
}

function roleLogFile(role: AgentRole, subtaskId = 1): string {
  if (role === 'analyst') return 'output-spec.log';
  if (role === 'planner') return 'output-plan.log';
  if (role === 'coder') return `output-st${subtaskId}.log`;
  if (role === 'qa') return 'output-qa.log';
  return 'output-merge.log';
}

function plannedSubtasks(task: SeedTask): Array<{ id: number; title: string; completed?: boolean }> {
  const plan = task.plan as { subtasks?: Array<{ id: number; title: string; completed?: boolean }> } | undefined;
  return plan?.subtasks ?? [];
}

function coderSubtaskIds(task: SeedTask): number[] {
  const subtasks = plannedSubtasks(task);
  if (!subtasks.length) return [1];

  if (task.phase !== 'implement') return subtasks.map((subtask) => subtask.id);

  const completed = subtasks.filter((subtask) => subtask.completed).map((subtask) => subtask.id);
  const active = subtasks.find((subtask) => !subtask.completed);
  if (active) completed.push(active.id);
  return [...new Set(completed.length ? completed : [subtasks[0].id])];
}

function transcriptRoleLogs(transcript: string | undefined, task: SeedTask): Record<string, string> {
  if (!transcript) return {};
  const grouped = new Map<string, string[]>();
  const coderIds = coderSubtaskIds(task);
  let currentRole: AgentRole | 'orchestrator' | null = null;

  let currentCoderId = coderIds[0];
  for (const line of transcript.split('\n')) {
    const detected = roleForTranscriptLine(line);
    if (detected) {
      currentRole = detected;
      if (detected === 'coder') {
        const subtaskMatch = line.match(/Subtask\s+(\d+)\s*\//i);
        const detectedId = subtaskMatch ? Number(subtaskMatch[1]) : undefined;
        currentCoderId = detectedId && coderIds.includes(detectedId) ? detectedId : coderIds[0];
      }
    }
    if (!currentRole) continue;

    const file = currentRole === 'coder'
      ? roleLogFile('coder', currentCoderId)
      : currentRole === 'orchestrator' ? 'output.log' : roleLogFile(currentRole);
    const lines = grouped.get(file) ?? [];
    lines.push(line);
    grouped.set(file, lines);
  }

  return Object.fromEntries([...grouped.entries()].map(([file, lines]) => [file, lines.join('\n')]));
}

function explicitRole(roleLogName: string): AgentRole | 'orchestrator' | null {
  if (roleLogName === 'output-spec.log') return 'analyst';
  if (roleLogName === 'output-plan.log') return 'planner';
  if (roleLogName === 'output-qa.log') return 'qa';
  if (roleLogName === 'output-merge.log') return 'merge';
  if (/^output-st\d+\.log$/.test(roleLogName)) return 'coder';
  if (roleLogName === 'output.log') return 'orchestrator';
  return null;
}

function firstLogTimestamp(task: SeedTask): number | null {
  const candidates = [task.outputLog ?? '', ...Object.values(task.roleLogs ?? {})];
  const stamps = candidates.flatMap((content) =>
    [...content.matchAll(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\] /gm)]
      .map((match) => Date.parse(`${match[1]}Z`))
  ).filter(Number.isFinite);
  return stamps.length ? Math.min(...stamps) : null;
}

function generatedRoleLog(task: SeedTask, role: AgentRole, startedAt: string, subtaskId = 1): string {
  const subtask = plannedSubtasks(task).find((item) => item.id === subtaskId);
  const snippets: Record<AgentRole, string> = {
    analyst: `[SESSION] Demo session started — role: analyst\n> Reviewing the seeded request for ${task.title}\n> Recording acceptance criteria in spec.md\n> Analyst handoff complete — scripted demo transcript; no CLI session was run.`,
    planner: `[SESSION] Demo session started — role: planner\n> Reading spec.md for ${task.title}\n> Mapping acceptance criteria to implementation subtasks\n> Planner handoff complete — scripted demo transcript; no CLI session was run.`,
    coder: `[SESSION] Demo session started — role: coder (subtask ${subtaskId})\n> Working on ${subtask?.title ?? task.title}\n> Checking the implementation against the subtask acceptance criteria\n> Coder checkpoint saved — scripted demo transcript; no source code was changed.`,
    qa: `[SESSION] Demo session started — role: qa-reviewer\n> Reviewing the implementation and acceptance criteria for ${task.title}\n> Overall seeded QA result: ${task.qaReport && (task.qaReport as { overall?: string }).overall ? (task.qaReport as { overall?: string }).overall : task.phase === 'failed' ? 'FAIL' : task.awaitingReviewReason ? 'prior QA phase completed before the analyst revision' : 'review pending'}\n> ${task.awaitingReviewReason ? 'This historical QA checkpoint precedes the current analyst revision; the task is now parked for human review.' : 'QA handoff recorded — scripted demo transcript; no tests were executed.'}`,
    merge: task.phase === 'failed'
      ? `[SESSION] Demo session started — role: merger\n> Checking merge readiness for ${task.title}\n> Task is failed; merge is intentionally blocked. This log only populates the demo Merger role filter. No PR was created and no merge ran.`
      : `[SESSION] Demo session started — role: merger\n> Reviewing delivery state for ${task.title}\n> ${task.prUrl ? `Placeholder PR link for display only: ${task.prUrl}` : 'Recording the seeded merge handoff; no real repository or merge operation exists.'}\n> Merger handoff complete — scripted demo transcript; no CLI session was run.`,
  };
  return timestampDemoLog(snippets[role], startedAt);
}

function buildTaskLogs(task: SeedTask): { orchestratorLog: string | null; roleLogs: Record<string, string> } {
  const splitLogs = transcriptRoleLogs(task.outputLog, task);
  const roleLogs = { ...splitLogs, ...(task.roleLogs ?? {}) };
  const rolesFromLogs = Object.entries(roleLogs)
    .map(([file, content]) => ({ role: explicitRole(file), content }))
    .filter((item): item is { role: AgentRole | 'orchestrator'; content: string } => !!item.role);
  const needed = new Set<AgentRole>([
    ...phaseAgentRoles(task),
    ...rolesFromLogs.map((item) => item.role).filter((role): role is AgentRole => role !== 'orchestrator'),
  ]);

  const timestamp = firstLogTimestamp(task);
  const fallback = Date.parse('2026-07-06T12:00:00Z');
  const revisionPark = task.phase === 'awaiting-review' && !!task.awaitingReviewReason;
  // A no-op spec revision is a later analyst session after the original
  // spec→plan→implement→QA work. Place missing historical phase logs before
  // the dated revision transcript instead of fabricating work after parking.
  const anchor = (timestamp ?? fallback) - (revisionPark ? 4 * 60 * 60 * 1000 : 0);
  const inferredRole = rolesFromLogs.find((item) => item.role !== 'orchestrator')?.role;
  const anchorRoleIndex = revisionPark ? 0 : inferredRole ? AGENT_ROLE_INDEX[inferredRole]
    : Math.max(-1, ...[...needed].map((role) => AGENT_ROLE_INDEX[role]));
  if (revisionPark && roleLogs['output-spec.log']) {
    const initialSpecLog = timestampDemoLog(
      `[SESSION] Demo session started — role: analyst (initial spec)\n> Reviewing the seeded request for ${task.title}\n> Recording the original acceptance criteria before planning\n> Initial spec handoff complete — scripted demo transcript; no CLI session was run.`,
      new Date(anchor).toISOString().slice(0, 19),
    );
    roleLogs['output-spec.log'] = `${initialSpecLog}\n\n${roleLogs['output-spec.log']}`;
  }
  const coderIds = coderSubtaskIds(task);
  const transcriptCoderId = Object.keys(roleLogs)
    .map((file) => file.match(/^output-st(\d+)\.log$/))
    .find((match) => !!match)?.[1];
  const anchorCoderId = transcriptCoderId ? Number(transcriptCoderId)
    : task.phase === 'implement' ? coderIds[coderIds.length - 1] : coderIds[0];

  for (const role of needed) {
    const roleFiles = role === 'coder'
      ? coderIds.map((id) => roleLogFile('coder', id))
      : [roleLogFile(role)];
    for (const file of roleFiles) {
      if (roleLogs[file]) continue;
      const roleIndex = AGENT_ROLE_INDEX[role];
      const idMatch = file.match(/^output-st(\d+)\.log$/);
      const subtaskOffset = role === 'coder' && idMatch
        ? (Number(idMatch[1]) - anchorCoderId) * 10 * 60 * 1000
        : 0;
      const startedAt = new Date(anchor + (roleIndex - anchorRoleIndex) * 60 * 60 * 1000 + subtaskOffset)
        .toISOString().slice(0, 19);
      roleLogs[file] = generatedRoleLog(task, role, startedAt, idMatch ? Number(idMatch[1]) : 1);
    }
  }

  const existingOrchestrator = roleLogs['output.log'];
  const earliestRoleStart = Math.min(anchor, ...[...needed].flatMap((role) => {
    const roleStarts = role === 'coder' ? coderIds.map((id) => {
      const offset = (id - anchorCoderId) * 10 * 60 * 1000;
      return anchor + (AGENT_ROLE_INDEX[role] - anchorRoleIndex) * 60 * 60 * 1000 + offset;
    }) : [anchor + (AGENT_ROLE_INDEX[role] - anchorRoleIndex) * 60 * 60 * 1000];
    return roleStarts;
  }));
  const orchestratorLog = existingOrchestrator ?? (task.phase === 'backlog' ? null : timestampDemoLog(
    `[ORCHESTRATOR] ${task.title}\nTask is seeded in phase '${task.phase}'.\nDemo transcript only — no agent subprocesses or external services were run.`,
    new Date(earliestRoleStart - 60 * 1000).toISOString().slice(0, 19),
  ));
  delete roleLogs['output.log'];
  return { orchestratorLog, roleLogs };
}

function writeTaskLogs(task: SeedTask, dir?: string) {
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const taskDir = dir ?? join(TEAMAI_DIR, slug);
  mkdirSync(taskDir, { recursive: true });
  const { orchestratorLog, roleLogs } = buildTaskLogs(task);
  const expected = new Set([...(orchestratorLog ? ['output.log'] : []), ...Object.keys(roleLogs)]);

  // These are generated terminal artifacts. Remove stale role tabs so the UI
  // reflects work through the ticket's current phase, not a previous seed.
  for (const filename of readdirSync(taskDir)) {
    if (/^output.*\.log$/.test(filename) && !expected.has(filename)) unlinkSync(join(taskDir, filename));
  }
  if (orchestratorLog) writeFileSync(join(taskDir, 'output.log'), orchestratorLog);
  for (const [file, content] of Object.entries(roleLogs)) writeFileSync(join(taskDir, file), content);
}

function writeTask(task: SeedTask) {
  const slug = task.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const dir = join(TEAMAI_DIR, slug);
  mkdirSync(dir, { recursive: true });

  writeFileSync(join(dir, 'task.json'), JSON.stringify({
    id: task.id,
    title: task.title,
    description: task.description,
    phase: task.phase,
    source: task.source,
    competitiveContext: task.competitiveContext,
    // Optional fields are omitted rather than written as null — the UI treats
    // an absent prUrl/awaitingReviewReason as "not set".
    ...(task.prUrl ? { prUrl: task.prUrl } : {}),
    ...(task.mergeStrategy ? { mergeStrategy: task.mergeStrategy } : {}),
    ...(task.awaitingReviewReason ? { awaitingReviewReason: task.awaitingReviewReason } : {}),
    ...(task.failureReason ? { failureReason: task.failureReason } : {}),
    createdAt: '2026-07-06T10:00:00.000Z',
    updatedAt: '2026-07-06T18:00:00.000Z',
  }, null, 2));

  const eventLines = task.events.map(phase =>
    JSON.stringify({ phase, timestamp: '2026-07-06T18:00:00.000Z' }),
  ).join('\n') + '\n';
  writeFileSync(join(dir, 'events.jsonl'), eventLines);

  if (task.spec) writeFileSync(join(dir, 'spec.md'), task.spec);
  if (task.plan) writeFileSync(join(dir, 'plan.json'), JSON.stringify(task.plan, null, 2));
  if (task.qaReport) writeFileSync(join(dir, 'qa_report.json'), JSON.stringify(task.qaReport, null, 2));
  if (task.completionSummary) writeFileSync(join(dir, 'completion_summary.md'), task.completionSummary);
  writeTaskLogs(task, dir);
  if (task.diff) writeFileSync(join(dir, 'diff.txt'), task.diff);
}

// ── DONE-column history (fake git repo) ─────────────────────────────
//
// The app's DONE column reconstructs *completed* tickets from the target
// repo's own history: `git log --grep '^Task: '` for commit trailers (and
// merged-PR bodies via `gh`, which the demo has no remote for). A throwaway
// repo with dated, trailer-bearing commits is therefore what makes the
// Delivered section show history-reconstructed cards sitting underneath the
// disk DONE tasks.
//
// The parent TeamAI repo ignores demo/.git and demo/src (see .gitignore), so
// none of this is committed upstream and the nested repo never registers as
// an embedded repository.

interface HistoryEntry {
  /** Path under demo/, created by this commit. */
  file: string;
  /** Conventional-commit subject — becomes the card title (type prefix stripped). */
  subject: string;
  /** Body lines above the trailer block — become the card summary. */
  summary: string[];
  /** Trailer block, mirroring the real builder's format exactly. */
  trailers: { task: string; taskId: string; qa: string; phases: string };
  /** ISO commit date — drives the card's relative "2mo ago" timestamp. */
  date: string;
  content: string;
}

const HISTORY: HistoryEntry[] = [
  {
    file: 'src/checkout/guest.ts',
    subject: 'feat: Guest checkout without account creation',
    summary: [
      'Anonymous sessions can now reach cart and checkout with only an email',
      'required. An existing account with the same address is linked at order',
      'time instead of being duplicated.',
    ],
    trailers: { task: 'guest-checkout-without-account-creation', taskId: 'DONE-002', qa: 'PASS (6/6 criteria)', phases: 'spec>plan>implement>qa-review>merge' },
    date: '2026-08-19T09:41:38+01:00',
    content: `/**
 * Guest checkout — anonymous sessions, email-only.
 * Added by ticket: guest-checkout-without-account-creation
 */
export interface GuestSession {
  email: string;
  cartId: string;
}

export function isAnonymous(session: { userId?: string }): boolean {
  return !session.userId;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
`,
  },
  {
    file: 'src/media/lazy-image.tsx',
    subject: 'feat: Product image lazy loading with CDN srcset',
    summary: [
      'Product grids load a 1x1 placeholder and upgrade to the real image once',
      'in view; srcset picks the right width per breakpoint.',
      'Median grid render dropped from 1.9s to 640ms.',
    ],
    trailers: { task: 'product-image-lazy-loading-cdn-srcset', taskId: 'DONE-101', qa: 'PASS (4/4 criteria)', phases: 'spec>plan>implement>qa-review>merge' },
    date: '2026-08-11T16:22:05+01:00',
    content: `/**
 * Lazy product image with CDN srcset.
 * Added by ticket: product-image-lazy-loading-cdn-srcset
 */
const CDN = process.env.NEXT_PUBLIC_CDN_URL;

export function srcSet(path: string): string {
  return [400, 800, 1200].map(w => CDN + '/w/' + w + path + ' ' + w + 'w').join(', ');
}

export function placeholder(): string {
  return 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
}
`,
  },
  {
    file: 'src/cart/money.ts',
    subject: 'fix: Cart total rounding at checkout',
    summary: [
      'Line items were summed as floats, so 19.99 + 0.01 + 0.01 charged',
      '20.009999. All money arithmetic now happens in integer minor units,',
      'rounding exactly once at the boundary.',
    ],
    trailers: { task: 'fix-cart-total-rounding-at-checkout', taskId: 'DONE-003', qa: 'PASS (3/3 criteria)', phases: 'spec>plan>implement>qa-review>merge' },
    date: '2026-08-28T15:31:53+01:00',
    content: `/**
 * Money arithmetic in integer minor units.
 * Added by ticket: fix-cart-total-rounding-at-checkout
 */
export function toMinor(amount: number): number {
  return Math.round(amount * 100);
}

export function format(minor: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency })
    .format(minor / 100);
}

export function sumMinor(amounts: number[]): number {
  return amounts.reduce((total, n) => total + toMinor(n), 0);
}
`,
  },
  {
    file: 'src/consent/banner.tsx',
    subject: 'feat: GDPR cookie consent banner',
    summary: [
      'Consent is captured before any non-essential script runs, stored with a',
      'timestamp, and re-requested after 12 months.',
    ],
    trailers: { task: 'gdpr-cookie-consent-banner', taskId: 'DONE-104', qa: 'PASS (5/5 criteria)', phases: 'spec>plan>implement>qa-review>merge' },
    date: '2026-09-04T11:07:44+01:00',
    content: `/**
 * Cookie consent gate.
 * Added by ticket: gdpr-cookie-consent-banner
 */
export const CONSENT_KEY = 'shopforge.consent.v1';
export const CONSENT_TTL_MONTHS = 12;

export interface Consent {
  essential: true;
  analytics: boolean;
  marketing: boolean;
  capturedAt: string;
}

export function needsRenewal(consent: Consent): boolean {
  const months = (Date.now() - Date.parse(consent.capturedAt)) / 2.628e9;
  return months >= CONSENT_TTL_MONTHS;
}
`,
  },
  {
    file: 'src/pricing/rules.ts',
    subject: 'refactor: Extract pricing rules into a shared module',
    summary: [
      'Cart, checkout and the receipt each carried their own copy of the discount',
      'rules; they now share one module so a rule change lands in one place.',
    ],
    trailers: { task: 'extract-pricing-rules-into-shared-module', taskId: 'DONE-105', qa: 'PASS (3/3 criteria)', phases: 'spec>plan>implement>qa-review>merge' },
    date: '2026-09-12T18:45:12+01:00',
    content: `/**
 * Shared pricing rules.
 * Added by ticket: extract-pricing-rules-into-shared-module
 */
export type Rule = (subtotalMinor: number, codes: string[]) => number;

export const RULES: Record<string, Rule> = {
  SAVE20: (subtotal) => Math.round(subtotal * 0.2),
  FIVEOFF: () => 500,
};

export function applyRules(subtotalMinor: number, codes: string[]): number {
  const total = codes.reduce((sum, code) => sum + (RULES[code]?.(subtotalMinor, codes) ?? 0), 0);
  return Math.min(total, subtotalMinor);
}
`,
  },
];

/**
 * Create a throwaway git repo inside demo/ whose commits carry the ticket
 * trailers the history scanner greps for. Returns the number of commits made.
 */
function seedGitHistory(): number {
  rmDir(join(DEMO_DIR, '.git'));
  rmDir(join(DEMO_DIR, 'src'));
  mkdirSync(join(DEMO_DIR, 'src'), { recursive: true });

  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: DEMO_DIR, stdio: 'pipe', encoding: 'utf-8' });

  // Hide the files the seed itself generates from the nested repo, so its
  // status stays clean without adding tracked files to demo/ for the parent
  // repo to pick up.
  const excludeDir = join(DEMO_DIR, '.git', 'info');
  mkdirSync(excludeDir, { recursive: true });
  writeFileSync(
    join(excludeDir, 'exclude'),
    ['.teamai/', '.claude/', 'CLAUDE.md', 'README.md', '.gitkeep', 'node_modules/', ''].join('\n'),
  );

  let count = 0;
  for (const entry of HISTORY) {
    const filePath = join(DEMO_DIR, entry.file);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, entry.content);

    // Same shape the real builder emits: subject, body, blank line, trailers.
    const message = [
      entry.subject,
      '',
      ...entry.summary,
      '',
      `Task: ${entry.trailers.task}`,
      `Task-ID: ${entry.trailers.taskId}`,
      `QA: ${entry.trailers.qa}`,
      `Phases: ${entry.trailers.phases}`,
      'Reviewed-by: TeamAI QA agent',
      '',
    ].join('\n');

    execFileSync('git', ['add', entry.file], { cwd: DEMO_DIR, stdio: 'pipe', encoding: 'utf-8' });
    execFileSync(
      'git',
      ['-c', 'user.name=ShopForge Dev', '-c', 'user.email=dev@shopforge.example', 'commit', '-q', '-m', message],
      {
        cwd: DEMO_DIR,
        stdio: 'pipe',
        encoding: 'utf-8',
        env: { ...process.env, GIT_AUTHOR_DATE: entry.date, GIT_COMMITTER_DATE: entry.date },
      },
    );
    count++;
  }

  return count;
}

// ── Main ────────────────────────────────────────────────────────────

function verifyExistingDemoLogs(task: SeedTask, dir: string): string[] {
  const filenames = readdirSync(dir).filter((filename) => /^output.*\.log$/.test(filename));
  const present = new Set(filenames);
  const required = phaseAgentRoles(task).flatMap((role) => role === 'coder'
    ? coderSubtaskIds(task).map((id) => roleLogFile('coder', id))
    : [roleLogFile(role)]);
  if (task.phase !== 'backlog') required.push('output.log');
  for (const filename of required) {
    if (!present.has(filename)) throw new Error(`${task.id}: missing required ${filename}`);
  }

  for (const filename of filenames) {
    const content = readFileSync(join(dir, filename), 'utf-8');
    let previousTimestamp = -Infinity;
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      const match = line.match(/^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\] /);
      if (!match) throw new Error(`${task.id}: undated line in ${filename}: ${line}`);
      const timestamp = Date.parse(`${match[1]}Z`);
      if (!Number.isFinite(timestamp) || timestamp < previousTimestamp) {
        throw new Error(`${task.id}: invalid or non-monotonic timestamp in ${filename}: ${line}`);
      }
      previousTimestamp = timestamp;
    }
  }
  return filenames.sort();
}

function refreshExistingDemoLogs(): void {
  if (!existsSync(TEAMAI_DIR)) throw new Error(`Demo task store not found: ${TEAMAI_DIR}`);

  const phases = new Set(['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review', 'pr-open', 'done', 'failed']);
  const targets: Array<{ task: SeedTask; dir: string }> = [];
  for (const seededTask of TASKS) {
    const slug = seededTask.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const dir = join(TEAMAI_DIR, slug);
    const taskPath = join(dir, 'task.json');
    if (!existsSync(dir) || !existsSync(taskPath)) {
      throw new Error(`Refusing partial logs-only refresh: missing existing task data for ${seededTask.id}`);
    }

    const saved = JSON.parse(readFileSync(taskPath, 'utf-8')) as {
      id?: string; phase?: string; prUrl?: string; mergeStrategy?: string;
    };
    if (saved.id !== seededTask.id) {
      throw new Error(`Refusing logs-only refresh: expected ${seededTask.id} in ${taskPath}, found ${saved.id ?? 'no id'}`);
    }
    if (saved.phase && !phases.has(saved.phase)) {
      throw new Error(`Refusing logs-only refresh: unknown phase '${saved.phase}' for ${seededTask.id}`);
    }

    const planPath = join(dir, 'plan.json');
    const plan = existsSync(planPath) ? JSON.parse(readFileSync(planPath, 'utf-8')) as object : seededTask.plan;
    targets.push({
      dir,
      task: {
        ...seededTask,
        phase: saved.phase ?? seededTask.phase,
        plan,
        prUrl: saved.prUrl ?? seededTask.prUrl,
        mergeStrategy: saved.mergeStrategy ?? seededTask.mergeStrategy,
      },
    });
  }

  // Validate every target before changing any files. This mode only writes or
  // prunes output*.log artifacts inside these existing task directories.
  for (const { task, dir } of targets) {
    writeTaskLogs(task, dir);
    const files = verifyExistingDemoLogs(task, dir);
    console.log(`  ${task.id} (${task.phase}): ${files.map((file) => file
      .replace('output-spec.log', 'analyst')
      .replace('output-plan.log', 'planner')
      .replace(/^output-st(\d+)\.log$/, 'coder(subtask $1)')
      .replace('output-qa.log', 'QA')
      .replace('output-merge.log', 'merger')
      .replace('output.log', 'orchestrator')).join(', ') || 'no agent logs'}`);
  }
  console.log(`\n✅ Refreshed terminal logs for ${targets.length} existing demo tasks; task data and demo git state were left untouched.`);
}

if (logsOnly) {
  refreshExistingDemoLogs();
  process.exit(0);
}

console.log('Re-seeding ShopForge demo project...');

// Wipe and recreate
rmDir(join(DEMO_DIR, '.teamai'));
rmDir(join(DEMO_DIR, '.claude'));
if (existsSync(join(DEMO_DIR, '.worktrees'))) rmDir(join(DEMO_DIR, '.worktrees'));
// Generated source tree + nested repo (recreated by seedGitHistory below)
rmDir(join(DEMO_DIR, 'src'));
rmDir(join(DEMO_DIR, '.git'));

mkdirSync(TEAMAI_DIR, { recursive: true });

// Pipeline config — demo:true prevents the orchestrator from processing tasks
writeFileSync(join(TEAMAI_DIR, 'pipeline.json'), JSON.stringify({
  enabledPhases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
  autoAdvance: false,
  maxConcurrentSessions: 3,
  demo: true,
}, null, 2));

// Write all tasks
for (const task of TASKS) writeTask(task);

// Write roadmap
const roadmapDir = join(TEAMAI_DIR, 'roadmap');
mkdirSync(roadmapDir, { recursive: true });
writeFileSync(join(roadmapDir, 'roadmap-2026-07-06.json'), JSON.stringify(ROADMAP, null, 2));

// Scaffold .claude/
scaffoldClaude();

// Fake git history that the DONE column reconstructs cards from
const historyCount = seedGitHistory();

// Summary
const phases: Record<string, number> = {};
for (const t of TASKS) phases[t.phase] = (phases[t.phase] || 0) + 1;
console.log('\n✅ Demo re-seeded with', TASKS.length, 'tasks:');
for (const [phase, count] of Object.entries(phases)) {
  console.log(`  ${phase}: ${count}`);
}
console.log(`  Roadmap: ${ROADMAP.phases.now.length + ROADMAP.phases.next.length + ROADMAP.phases.later.length + ROADMAP.phases.icebox.length} items`);
console.log(`  DONE history: ${historyCount} tickets reconstructed from git (demo/src)`);

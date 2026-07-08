// Seed script for the ShopForge e-commerce demo project.
// Creates 15 tasks across all 8 pipeline phases and a roadmap with 14 items.
// Usage: npx tsx seed-demo.ts [--yes]
//
// Put at project root (outside demo/) so re-seeding doesn't wipe this script.

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, cpSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { createHash } from 'crypto';

const DEMO_DIR = join(process.cwd(), 'demo');
const DEFAULTS_DIR = join(process.cwd(), 'teamai', 'defaults');
const TEAMAI_DIR = join(DEMO_DIR, '.teamai');

const args = process.argv.slice(2);
const skipConfirm = args.includes('--yes') || args.includes('-y');

if (!skipConfirm) {
  console.log('This will DELETE and re-create demo/.teamai/ and demo/.claude/.');
  console.log('Run with --yes to skip this prompt.');
  process.exit(0);
}

function checksum(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
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

  // Write scaffold manifest
  const manifest: Record<string, string> = {};
  for (const file of readdirSync(cmdsDest)) {
    manifest[`commands/${file}`] = checksum(readFileSync(join(cmdsDest, file), 'utf-8'));
  }
  if (existsSync(workflowDest)) {
    manifest['teamai-workflow.md'] = checksum(readFileSync(workflowDest, 'utf-8'));
  }
  writeFileSync(join(claudeDir, '.teamai-scaffold.json'), JSON.stringify({ version: 1, files: manifest }, null, 2));

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
  outputLog?: string;
  events: string[];  // phase names in order
  source?: string;
  competitiveContext?: string;
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
    outputLog: `[IMPLEMENT] Cart Quantity Fix — Subtask 3/4: Optimistic updates with rollback
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

[WAITING] Claude session budget: 42% remaining (2.5min of 6min used)
`,
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
    outputLog: `[IMPLEMENT] Shipping Rate Calculator — Subtask 3/5: Free shipping threshold
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

[WAITING] Claude session budget: 38% remaining (2.3min of 6min used)
`,
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
    outputLog: `[QA-REVIEW] Search Partial Match — Attempt 1
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
`,
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
    outputLog: `[QA-REVIEW] Mobile Nav Auto-Close — Attempt 1
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
`,
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review'],
  },

  // ═══ AWAITING REVIEW (2) ═══
  {
    id: 'REVIEW-001',
    title: 'Dark Mode Support',
    description: 'Add system-preference-based dark mode with a manual toggle in the user settings.',
    phase: 'awaiting-review',
    outputLog: `[QA-REVIEW] Dark Mode Support — Attempt 1
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
`,
    plan: {
      subtasks: [
        { id: 1, title: 'Add CSS custom properties for color scheme', acceptance_criteria: ['All colors use var(--color-*) tokens', 'Dark palette defined alongside light'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Implement theme toggle in settings', acceptance_criteria: ['Toggle switches between light/dark/system', 'Preference persists in localStorage'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Update all components to use CSS variables', acceptance_criteria: ['No hardcoded colors remain', 'All components render correctly in dark mode'], depends_on: [1], qa_flagged: false },
      ],
    },
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review'],
  },
  {
    id: 'REVIEW-002',
    title: 'Wishlist with Shareable Links',
    description: 'Users can create wishlists, add products, and share a public link with friends and family.',
    phase: 'awaiting-review',
    outputLog: `[QA-REVIEW] Wishlist with Shareable Links — Attempt 1
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
`,
    plan: {
      subtasks: [
        { id: 1, title: 'Wishlist CRUD API', acceptance_criteria: ['Create/read/update/delete wishlists', 'Add/remove products from wishlist'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Shareable public link', acceptance_criteria: ['Each wishlist gets a unique UUID-based URL', 'Public page shows wishlist items in read-only mode'], depends_on: [1], qa_flagged: false },
        { id: 3, title: 'Wishlist UI in account area', acceptance_criteria: ['List of wishlists in account dropdown', 'Add-to-wishlist button on product cards'], depends_on: [1], qa_flagged: false },
      ],
    },
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'awaiting-review'],
  },

  // ═══ DONE (1) ═══
  {
    id: 'DONE-001',
    title: 'Order Tracking Dashboard',
    description: 'Real-time order tracking with map view showing the package\'s current location and estimated delivery window.',
    phase: 'done',
    outputLog: `[QA-REVIEW] Order Tracking Dashboard — Attempt 1
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
`,
    spec: '# Order Tracking Dashboard\n\n## Acceptance Criteria\n1. Map shows package location with a pin\n2. Status timeline shows: Order Placed → Processing → Shipped → Out for Delivery → Delivered\n3. Estimated delivery window updates dynamically\n4. Push notification when status changes\n5. Tracking number is clickable and opens carrier\'s tracking page\n',
    plan: {
      subtasks: [
        { id: 1, title: 'Integrate map component (Mapbox)', acceptance_criteria: ['Map renders with package location pin', 'Pin updates when location changes'], depends_on: [], qa_flagged: false },
        { id: 2, title: 'Build status timeline component', acceptance_criteria: ['5-step timeline with current step highlighted', 'Completed steps show checkmark'], depends_on: [], qa_flagged: false },
        { id: 3, title: 'Delivery ETA estimation', acceptance_criteria: ['ETA updates based on carrier API', 'Shows "Delivered" when package arrives'], depends_on: [1], qa_flagged: false },
        { id: 4, title: 'Push notification integration', acceptance_criteria: ['User receives notification on status change', 'Notification links to tracking page'], depends_on: [3], qa_flagged: false },
      ],
    },
    completionSummary: 'All 4 subtasks complete. Mapbox integration with live tracking, 5-step timeline, dynamic ETA from carrier API, and push notifications via Web Push API. All tests pass.',
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
  if (task.outputLog) writeFileSync(join(dir, 'output.log'), task.outputLog);
}

// ── Main ────────────────────────────────────────────────────────────

console.log('Re-seeding ShopForge demo project...');

// Wipe and recreate
rmDir(join(DEMO_DIR, '.teamai'));
rmDir(join(DEMO_DIR, '.claude'));
if (existsSync(join(DEMO_DIR, '.worktrees'))) rmDir(join(DEMO_DIR, '.worktrees'));

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

// Summary
const phases: Record<string, number> = {};
for (const t of TASKS) phases[t.phase] = (phases[t.phase] || 0) + 1;
console.log('\n✅ Demo re-seeded with', TASKS.length, 'tasks:');
for (const [phase, count] of Object.entries(phases)) {
  console.log(`  ${phase}: ${count}`);
}
console.log(`  Roadmap: ${ROADMAP.phases.now.length + ROADMAP.phases.next.length + ROADMAP.phases.later.length + ROADMAP.phases.icebox.length} items`);

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
    events: ['backlog', 'spec', 'plan', 'implement'],
  },
  {
    id: 'IMPL-002',
    title: 'Shipping Rate Calculator Based on Weight and Distance',
    description: 'Replace the flat-rate shipping with a dynamic calculator that factors in package weight, dimensions, and delivery distance.',
    phase: 'implement',
    spec: '# Shipping Rate Calculator\n\n## Overview\nDynamic shipping rates based on package weight (0.1-30kg), dimensions, and delivery zone.\n\n## Acceptance Criteria\n1. Rate is calculated as: base_rate + (weight_kg * 1.50) + (zone_multiplier * 2.00)\n2. Three delivery zones: Local (1x), Regional (1.5x), National (2.5x)\n3. Free shipping for orders over $75\n4. Rate is shown before the user enters payment details\n',
    events: ['backlog', 'spec', 'plan', 'implement'],
  },

  // ═══ QA REVIEW (2) ═══
  {
    id: 'QA-001',
    title: 'Fix Search Returns Empty Results for Partial Product Names',
    description: 'Full-text search only matches exact product names. Partial matches like "running sho" should return "Running Shoes".',
    phase: 'qa-review',
    spec: '# Search Partial Match\n\n## Acceptance Criteria\n1. Search for "running sho" returns "Running Shoes"\n2. Search is case-insensitive\n3. Search supports prefix matching (first 3+ chars)\n4. Empty search returns all products (not zero results)\n',
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
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review'],
  },
  {
    id: 'QA-002',
    title: 'Fix Mobile Nav Menu Doesn\'t Close After Link Click',
    description: 'On mobile, the hamburger menu stays open after clicking a navigation link. It should auto-close on link click.',
    phase: 'qa-review',
    spec: '# Mobile Nav Auto-Close\n\n## Acceptance Criteria\n1. Clicking any nav link in the mobile menu closes the menu\n2. Tapping the overlay/backdrop closes the menu\n3. Menu close animation is smooth (200ms slide-out)\n4. Focus is returned to the hamburger button after close\n5. Menu state is reset on viewport resize from mobile to desktop\n',
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
    events: ['backlog', 'spec', 'plan', 'implement', 'qa-review'],
  },

  // ═══ AWAITING REVIEW (2) ═══
  {
    id: 'REVIEW-001',
    title: 'Dark Mode Support',
    description: 'Add system-preference-based dark mode with a manual toggle in the user settings.',
    phase: 'awaiting-review',
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

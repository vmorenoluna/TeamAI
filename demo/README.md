# ShopForge Demo Project

A fake e-commerce demo project for TeamAI screenshots and demonstration. Contains 15 pre-seeded tasks across all 8 pipeline phases and a 14-item roadmap.

## Quick Start

```bash
# 1. Re-seed the demo (from project root)
npx tsx seed-demo.ts --yes

# 2. Launch the Electron app
cd teamai && npm run electron:dev

# 3. Register the demo project in the app UI
#    Path: C:\Users\dev\IdeaProjects\TeamAI\demo
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
| Awaiting Review | 2 | Dark Mode, Wishlist |
| Done | 1 | Order Tracking Dashboard |
| Failed | 1 | Checkout timeout (3 QA attempts) |

## Roadmap

14 items across 4 phases (Now, Next, Later, Icebox) with competitor analysis.

## Re-seeding

The seed script is at the project root (`seed-demo.ts`) so it survives demo directory wipes:

```bash
npx tsx seed-demo.ts --yes
```

This wipes and recreates `demo/.teamai/` and `demo/.claude/`.

## Screenshots

After re-seeding, capture fresh screenshots:

```bash
cd teamai && npx tsx scripts/take-screenshots.ts
```

Screenshots are saved to `teamai/docs/images/`. Move them to the project root docs:

```bash
mv teamai/docs/images/*.png docs/images/
```

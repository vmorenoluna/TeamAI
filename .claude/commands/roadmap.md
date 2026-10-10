<!-- .claude/commands/roadmap.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

You are a product strategist generating a prioritized feature roadmap.

The user may provide arguments in two forms:
- `/roadmap` — full analysis including auto-discovered competitor analysis
- `/roadmap --skip-competitors` — internal analysis only (skip competitor research)

Competitor analysis is **included by default** — the AI discovers competitors automatically
from the codebase and product domain. The user only needs a flag to opt *out*.

Parse $ARGUMENTS to detect the `--skip-competitors` and `--ideation-report <path>` flags.

---



## Phase 1: Codebase Audit (via Ideation)

If `--ideation-report <path>` is present in $ARGUMENTS, read that file directly
instead of running `/ideation`. Otherwise, run the `/ideation` command to produce
the codebase scan. If an ideation report from the last 24 hours already exists in
`.teamai/ideation/`, read it instead of re-running.

Also read the project's README, CLAUDE.md, and package.json (or equivalent) to understand:
- What the product does and who it's for (target audience)
- What the problem it solves and the domain it operates in
- Current feature set
- Tech stack and architecture patterns
- Project maturity (early prototype vs production)

---



## Phase 2: Competitor Analysis (skip only if --skip-competitors flag is present)

### 2a. Competitor Discovery
Using the project understanding from Phase 1, identify competitors automatically:
1. Determine the project's **category** from its README and feature set
   (e.g., "task management app", "API gateway", "e-commerce platform").
2. Use web search to find competitors:
   - Search: "{category} alternatives {year}"
   - Search: "best {category} tools"
   - Search: "{product name} vs" (if the project has a known product name)
3. Select the **top 3-5 most relevant competitors** based on:
   - Overlap in target audience
   - Overlap in feature set
   - Market presence (stars, downloads, pricing pages)
4. List the discovered competitors with a one-line rationale for each selection.

### 2b. Research
For each discovered competitor, use web/webfetch to find:
- The competitor's website, docs, and recent blog posts / changelogs
- Their pricing page and feature comparison tables
- Recent product announcements (last 6 months)
- Public GitHub repos (if open source) — scan for feature set and architecture

### 2c. Feature Comparison Matrix
Build a table:

| Feature | Our Project | Competitor A | Competitor B |
|---------|-------------|-------------|-------------|
| Feature X | ✅ / ❌ / Partial | ✅ / ❌ / Partial | ... |

### 2d. Competitive Positioning
For each competitor, identify:
- **Where they're ahead**: features they have that we don't have
- **Where we're ahead**: features we have that they don't
- **Their target audience**: who they're building for (and how it differs from ours)
- **Their recent direction**: what their last 3-5 releases/announcements signal about their strategy
- **Gaps they're ignoring**: underserved needs in the market that neither product addresses

---

## Phase 3: Roadmap Generation

### 3a. Collect All Findings
Combine the ideation scan (Phase 1) with competitor insights (Phase 2, if available).
The ideation scan provides the tactical findings (bugs, security issues, performance problems).
The competitor analysis provides the strategic findings (feature gaps, positioning opportunities).

### 3b. Generate Roadmap Items
For each finding, create a roadmap item with:
- **Title**: concise feature/fix name
- **Category**: one of: Critical Fix | Security | Performance | DX | New Feature | Competitive Response | Infrastructure
- **Priority**: P0 (urgent) / P1 (high) / P2 (medium) / P3 (low)
- **Complexity**: 1 (trivial) to 5 (major effort)
- **Description**: 2-3 sentences explaining what and why
- **Affected files**: list of files/modules involved
- **Source**: "ideation" or "competitor-analysis" — where this finding came from
- **Competitive context** (if applicable): which competitor has this, or which gap this fills

### 3c. Prioritization Logic
Rank by this priority order:
1. P0: Security vulnerabilities, data loss risks, broken core functionality
2. P1: Features that close competitive gaps or address the largest user pain points
3. P2: Performance improvements, DX improvements, missing tests
4. P3: Nice-to-haves, polish, exploratory features

### 3d. Group into Phases
Organize items into implementation phases:
- **Phase 1 (Now)**: P0 items + quick P1 wins (complexity ≤ 2)
- **Phase 2 (Next)**: Remaining P1 items + high-impact P2 items
- **Phase 3 (Later)**: P2 items + P3 items
- **Icebox**: Ideas worth tracking but not yet prioritized

---



## Output
Save the roadmap to `.teamai/roadmap/roadmap-{date}.md` with:
1. Executive summary (3-5 sentences)
2. Ideation findings summary (from Phase 1, with link to full ideation report)
3. Competitor comparison matrix (if competitor analysis was run)
4. Phased roadmap with all items

Also save `.teamai/roadmap/roadmap-{date}.json` with this exact JSON structure:
```json
{
  "generated_at": "ISO 8601 timestamp",
  "executive_summary": "3-5 sentence summary",
  "competitor_analysis_run": true/false,
  "phases": {
    "now": [{ "title": "...", "priority": "P0", "complexity": 3, "category": "...", "description": "...", "affected_files": [], "source": "..." }],
    "next": [...],
    "later": [...],
    "icebox": [...]
  }
}
```

Print a summary of the top 10 highest-priority items to stdout.
```
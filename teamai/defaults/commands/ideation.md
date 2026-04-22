<!-- .claude/commands/ideation.md -->
Read and adopt the role defined in .claude/roles/analyst.md before proceeding.

You are performing a deep scan of this codebase to discover improvements,
performance issues, and security vulnerabilities. This is NOT a roadmap —
it's a targeted audit that surfaces actionable findings.

## Step 1: Security Scan
Search the codebase for:
- Hardcoded secrets, API keys, tokens, passwords (grep for patterns like `api_key`, `secret`, `password`, `token` in string literals)
- SQL injection vectors (string concatenation in queries)
- Missing input validation on user-facing endpoints
- Missing authentication/authorization checks
- Insecure dependencies (check for known CVEs in package.json / lock file versions)
- Exposed debug endpoints or verbose error messages in production paths
- Missing CORS configuration or overly permissive CORS
- Missing rate limiting on public endpoints

## Step 2: Performance Scan
Search for:
- N+1 query patterns (loops that make individual database/API calls)
- Synchronous operations that should be async (blocking I/O in request handlers)
- Missing indexes (large collections queried without indexed fields)
- Unbounded queries (no LIMIT/pagination on list endpoints)
- Large bundle sizes (unused imports, heavy dependencies that could be lazy-loaded)
- Missing caching where repeated expensive computations occur
- Memory leaks (event listeners never removed, growing arrays/maps never pruned)

## Step 3: Code Quality Scan
Search for:
- Dead code (exported functions/classes with zero imports)
- Duplicated logic (similar code blocks across multiple files)
- Missing error handling (try/catch gaps, unhandled promise rejections)
- Inconsistent patterns (some files use one approach, others use another)
- Missing types (any casts, untyped function parameters in TypeScript)
- Overly complex functions (deeply nested conditionals, functions > 50 lines)

## Step 4: Infrastructure Scan
Check for:
- Missing or incomplete CI/CD configuration
- Missing environment variable validation at startup
- Missing health check endpoints
- Missing structured logging
- Missing database migration scripts
- Missing backup/recovery procedures in documentation

## Output
Save to `.teamai/ideation/ideation-{date}.json`:
```json
{
  "security": [
    { "severity": "critical|high|medium|low", "title": "...", "file": "...", "line": N, "description": "...", "fix": "..." }
  ],
  "performance": [ ... ],
  "code_quality": [ ... ],
  "infrastructure": [ ... ],
  "summary": {
    "critical": N,
    "high": N,
    "medium": N,
    "low": N,
    "total": N
  }
</code>
```

Print a summary table to stdout showing counts by severity and category.
Each finding should be specific enough to act on — file path, line number, and a concrete fix description.
```
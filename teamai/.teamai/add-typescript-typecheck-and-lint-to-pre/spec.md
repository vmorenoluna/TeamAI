# Spec: Add TypeScript typecheck and lint to pre-commit hooks

## Overview
Add automated quality gates that run `tsc --noEmit` and `eslint` on staged files before every commit, preventing broken TypeScript or lint-violating code from entering the repository. Uses husky for git hooks and lint-staged to only run checks on files about to be committed.

## Requirements
1. Install husky and lint-staged as dev dependencies
2. Configure husky to initialize on `npm install` (prepare script)
3. Add a pre-commit hook that runs lint-staged
4. Configure lint-staged to run `tsc --noEmit` on staged TypeScript files
5. Configure lint-staged to run `eslint --fix` on staged TypeScript/TSX files
6. Add a `typecheck` npm script for manual typechecking
7. Ensure the pre-commit hook is fast (only checks staged files, not the entire project)
8. The hook should block the commit on failure (exit non-zero)

## Acceptance Criteria
- **Given** a staged `.ts` file with a type error, **When** `git commit` is run, **Then** the commit is blocked and the type error is shown
- **Given** a staged `.tsx` file with an ESLint violation, **When** `git commit` is run, **Then** the commit is blocked and the lint error is shown
- **Given** only non-TS files are staged (e.g. `.json`, `.md`), **When** `git commit` is run, **Then** the commit proceeds without running tsc/eslint
- **Given** all staged TS files pass typecheck and lint, **When** `git commit` is run, **Then** the commit succeeds
- **Given** `npm run typecheck` is run, **When** executed, **Then** `tsc --noEmit` runs on the full project and reports errors
- **Given** `npm install` is run in a fresh clone, **When** hooks directory does not exist, **Then** husky creates the `.husky/` directory with the pre-commit hook

## Files to Modify
- `teamai/package.json` — add lint-staged config, husky prepare script, typecheck script, new devDependencies
- New: `teamai/.husky/pre-commit` — the actual pre-commit hook that runs npx lint-staged

## New Files to Create
- `teamai/.husky/pre-commit` — git hook entry point

## Dependencies & Risks
- husky@9 and lint-staged@15 are mature, stable packages
- No breaking changes to existing workflows
- Developers can bypass with `git commit --no-verify` if needed
- The typecheck on staged files uses `tsc --noEmit --project tsconfig.json` which checks the full project (not just staged files) — this is a known limitation of tsc; filtering to staged files is not possible with tsc alone. Accept this tradeoff: full typecheck on commit is the safe default
- ESLint can be configured to only lint staged files via lint-staged's file globbing

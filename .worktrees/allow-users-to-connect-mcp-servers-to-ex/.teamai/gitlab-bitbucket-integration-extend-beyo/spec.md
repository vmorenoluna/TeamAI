# GitLab + Bitbucket Integration

## Goal
Extend the merge/create-pr phase beyond GitHub-only to support GitLab merge requests and Bitbucket pull requests.

## Current State
- `orchestrator.runCreatePR()` explicitly uses GitHub MCP server's `create_pull_request` tool
- Prompt instructs the agent: "Use the GitHub MCP server's `create_pull_request` tool"
- Only GitHub is supported — GitLab/Bitbucket users cannot use the merge phase

## Desired State
- Auto-detect the Git hosting platform from remote origin URL
- GitHub: existing flow (create_pull_request)
- GitLab: create merge request via glab CLI or GitLab API
- Bitbucket: create pull request via Bitbucket API
- Platform detection happens in `runCreatePR()` before agent prompt construction

## Platform Detection Heuristic
- `github.com` / `github.` → GitHub
- `gitlab.com` / `gitlab.` / self-hosted GitLab path → GitLab
- `bitbucket.org` / `bitbucket.` → Bitbucket

## Scope
1. Add `detectGitPlatform()` helper function to `orchestrator.ts`
2. Update `runCreatePR()` to construct platform-specific prompts
3. For GitLab: support `glab mr create` CLI if available
4. For Bitbucket: support Bitbucket REST API v2 with token
5. Update the merger role template if needed
6. Add platform config to task artifacts (for UI display)

## Out of Scope
- Azure DevOps / self-hosted Gitea/Gogs
- OAuth token management (relies on existing git credentials)
- Cross-platform merge strategies

## Acceptance Criteria
- [ ] Auto-detects GitHub, GitLab, or Bitbucket from remote URL
- [ ] Creates PR on GitHub (existing flow, unchanged)
- [ ] Creates MR on GitLab when glab CLI is available
- [ ] Creates PR on Bitbucket with API token
- [ ] Falls back to manual instructions when auto-detection fails
- [ ] UI shows detected platform in merge/review phase

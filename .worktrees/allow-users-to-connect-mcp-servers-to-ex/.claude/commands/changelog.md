<!-- .claude/commands/changelog.md -->
Generate release notes from recent git history.

## Instructions
1. Run `git log --oneline {last_tag}..HEAD` to get recent commits.
2. Group commits by type (feat, fix, chore, docs, refactor, test).
3. Write release notes in Keep a Changelog format.
4. Highlight breaking changes prominently.
5. Print the changelog to stdout.
```
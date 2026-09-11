# Contributing to TeamAI

Thanks for considering a contribution. This project is maintained solo, so please bear with turnaround times on reviews.

## Before you start

For anything beyond a small fix, open an issue first to discuss the change — it saves rework if the approach needs adjusting.

## Development setup

See the [Quick Start](README.md#quick-start) section in the root README.

## Making a change

1. Fork the repo and create a feature branch off `main`.
2. Make your changes, following the existing code style (see `teamai/CLAUDE.md` for the conventions AI coding agents follow in this repo — the same conventions apply to human contributors).
3. Add or update tests for anything behavioral.
4. Run the checks locally before opening a PR:
   ```bash
   cd teamai
   npm run lint
   npm run typecheck
   npm test
   ```
   For UI changes, also run the relevant E2E spec (see `teamai/README.md`'s Testing section).
5. Update `teamai/CHANGELOG.md`'s `[Unreleased]` section if the change is user-facing.
6. Open a pull request against `main` with a clear description of what changed and why.

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/) (`feat(scope): ...`, `fix(scope): ...`, `chore: ...`, `docs: ...`).

## Reporting bugs / requesting features

Use the issue templates in the [issue tracker](https://github.com/vmorenoluna/TeamAI/issues/new/choose).

## Security issues

Do not open a public issue for a security vulnerability — see [SECURITY.md](SECURITY.md).

## Code of Conduct

This project follows the [Code of Conduct](CODE_OF_CONDUCT.md). By participating, you're expected to uphold it.

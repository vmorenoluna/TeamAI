# Changelog

## [Unreleased]

## [0.1.3] — 2026-10-08

- Resolve Next.js native-package symlinks whether their targets are absolute or relative, ensuring macOS and Linux release packages include the node-pty runtime shim

## [0.1.2] — 2026-10-08

- Allow packaged macOS and Linux builds without generated external shims to pass release validation; continue to reject any package that omits a shim its server bundle requires

## [0.1.1] — 2026-10-08

- Fix packaged Windows, macOS, and Linux apps returning HTTP 500 when Next.js could not resolve generated external-module shims; release builds now verify shims before uploading artifacts

## [0.1.0] — 2026-10-05

- Multi-agent Claude Code workflows with a Kanban board and automated spec-to-merge pipeline
- Auto mode, isolated worktrees, crash recovery, project/provider settings, and a Role Refinement Assistant
- Electron desktop app for Windows, macOS (Apple Silicon), and Linux; unsigned macOS builds require manual updates

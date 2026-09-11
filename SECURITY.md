# Security Policy

## Supported Versions

TeamAI is pre-1.0 (currently `0.x`). Only the latest released version is supported with security fixes.

## Reporting a Vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Instead, please report it privately using [GitHub Security Advisories](https://github.com/vmorenoluna/TeamAI/security/advisories/new) — this lets us discuss and fix the issue before it's publicly disclosed. If you'd rather not use GitHub's advisory flow, you can reach the maintainer via the email listed on their [GitHub profile](https://github.com/vmorenoluna).

Please include:
- A description of the vulnerability and its potential impact
- Steps to reproduce (a minimal repro is ideal)
- The affected version(s)

We'll acknowledge reports as promptly as we can and keep you updated as the issue is investigated and fixed.

## Scope Notes

TeamAI's agents execute shell commands with the same filesystem access as the user running it, by design (it's an autonomous coding-agent orchestrator). This is documented behavior, not a vulnerability in itself — see the Safety & Privacy section in the [README](README.md). Reports about sandboxing/isolation gaps for the **optional** Docker devcontainer mode are welcome; reports that TeamAI "can run arbitrary commands" without container isolation enabled are expected behavior, not a bug.

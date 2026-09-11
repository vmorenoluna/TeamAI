# Packaging Options for TeamAI

Goal: a single installable file that opens TeamAI as a native-like app window (not a browser tab).

## Architecture Context

TeamAI is a Next.js app with a **custom server** (`server.ts`) that:
- Handles HTTP + WebSocket on port 3000 (production default; dev mode uses 3002 via PORT env var)
- Spawns Claude CLI subprocesses for agent pipelines
- Manages git worktrees, file I/O, and container orchestration
- Depends on `node-pty` for terminal emulation

It cannot be a static site — it needs a long-running Node.js process.

---

## Option 1: Tauri (Recommended)

Wrap the web UI in a **Tauri** window, with the Node.js server running as a [sidecar](https://tauri.app/develop/sidecar/) process managed by Tauri's Rust backend.

| | |
|---|---|
| **Bundle size** | ~15–25 MB |
| **Single installer** | ✅ `.msi`/`.dmg`/`.deb`/`.AppImage` |
| **Own window** | ✅ Native OS window, no browser chrome |
| **Cross-platform** | ✅ Windows, macOS, Linux |
| **Maturity** | ✅ Active ecosystem, v2 is stable |

**How it works:** Tauri starts `server.ts` as a sidecar on a random port, opens a native webview window pointing to `http://localhost:{port}`, and kills the sidecar on window close. The user sees a single `.exe`/`.app` installer.

**Trade-off:** Requires Rust toolchain for builds. The sidecar needs to be compiled (or bundled as a standalone Node.js binary via `nexe`/SEA).

---

## Option 2: PWA + Standalone Server Binary

Make the app an **installable PWA** (manifest + service worker) and bundle the server into a **single Node.js executable**.

| | |
|---|---|
| **Bundle size** | ~40–60 MB (Node.js SEA includes the runtime) |
| **Single installer** | ✅ Single `.exe` (or shell script for macOS/Linux) |
| **Own window** | ✅ PWA opens in its own app-like window (no tabs/address bar) |
| **Cross-platform** | ✅ Anywhere Node.js runs |
| **Maturity** | ⚠️ Node.js SEA is experimental (v21+); PWA is mature |

**How it works:** User downloads `teamai.exe`, double-clicks → production server starts on port 3000 → browser opens to `localhost:3000`. They click "Install" in the browser → PWA installs → next time it opens as a standalone window. A helper script could auto-install the PWA via Chrome's `--app` flag for a one-click experience.

**Trade-off:** Two-step first-run experience (start server → install PWA). Can be smoothed with a launcher that opens Chrome in `--app` mode. Node.js SEA is still experimental.

---

## Option 3: Electron

Wrap everything in an **Electron** shell. The `main` process starts `server.ts` as a child process, then opens a `BrowserWindow` pointing to it.

| | |
|---|---|
| **Bundle size** | ~150–180 MB (includes full Chromium) |
| **Single installer** | ✅ `.exe`/`.dmg`/`.deb` via electron-builder |
| **Own window** | ✅ Full control over window chrome |
| **Cross-platform** | ✅ Mature on all platforms |
| **Maturity** | ✅ Battle-tested (VS Code, Slack, Discord) |

**Trade-off:** TeamAI originally **replaced an Electron-based approach** — likely due to bundle size and complexity. Going back to Electron would mean carrying a full Chromium instance with every install.

---

## Summary

| Option | Bundle Size | Complexity | Native Window | Single File |
|---|---|---|---|---|
| **Tauri** | 15–25 MB | Medium | ✅ | ✅ |
| **PWA + Binary** | 40–60 MB | Low | ✅ | ✅ |
| **Electron** | 150–180 MB | Low | ✅ | ✅ |

**Tauri** is the best fit: small bundle, native window, single installer, and it aligns with the decision to move away from Electron's bloat.

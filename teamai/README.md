# TeamAI

TeamAI is an Electron desktop app for orchestrating multi-agent Claude Code workflows.

## Development

From the `teamai/` directory:

```bash
npm ci
npm run dev
```

To launch Electron against the development server:

```bash
npm run electron:dev
```

The development server uses port `3002`. Production Electron uses port `3000`.

## Electron builds

The packaged app doesn't bundle a separate Node runtime. Production Electron runs its
custom server (`dist-server/server.cjs`) by spawning its own Electron binary with
`ELECTRON_RUN_AS_NODE=1` (see `electron/main.js`) — this makes Electron behave as a
plain Node process. The build also disables asar packing (`"asar": false` in
`package.json`'s `build` config) so the packaged app's files sit directly on the real
filesystem, where plain Node module resolution works normally.

One consequence of that: Next's build marks native-addon dependencies (`node-pty`) as
server externals via a symlink with an absolute target path, which doesn't survive
being copied into the package. `npm run build:electron` runs
`scripts/fix-external-symlinks.mjs` after `next build` to replace those with portable
proxies under `external-shims/` (a generated directory, not checked in) — see that
script's comments for the full explanation.

Build each platform on that platform — native dependencies (`sharp`, `esbuild`,
`node-pty`) are platform-specific and electron-builder can't cross-compile them from a
different OS.

```bash
npm ci
npm run electron:build        # Windows — NSIS installer + ZIP
npm run electron:build:mac    # macOS — DMG + ZIP
npm run electron:build:linux  # Linux — AppImage + deb
```

Outputs are written to `dist-electron/`. `npm run electron:build:all` runs all three
targets on the current host, but only produces a working build for the host's own
platform (the native modules for the other platforms aren't available) — prefer
separate per-platform CI jobs for real multi-platform releases.

## Verification

```bash
npm run typecheck
npm run lint
npm run build:electron
```

`npm run build:electron` builds both the Next application and the custom server artifact used by Electron.

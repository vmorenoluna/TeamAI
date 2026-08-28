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

Electron builds use the Next production build plus a standalone Node runtime for the custom server. The runtime is required because the packaged app must not depend on Node being installed on the user's machine.

Build each platform on that platform. Do not copy a runtime binary from one operating system into another platform's package.

### Windows

Run on Windows:

```bash
npm ci
mkdir runtime
copy (Get-Command node).Source runtime\node.exe
npm run electron:build
```

Outputs are written to `dist-electron/` as an NSIS installer and ZIP archive.

### macOS

Run on macOS:

```bash
npm ci
mkdir -p runtime/bin
cp "$(command -v node)" runtime/bin/node
chmod +x runtime/bin/node
npm run electron:build:mac
```

Outputs are written to `dist-electron/` as DMG and ZIP files.

### Linux

Run on Linux:

```bash
npm ci
mkdir -p runtime/bin
cp "$(command -v node)" runtime/bin/node
chmod +x runtime/bin/node
npm run electron:build:linux
```

Outputs are written to `dist-electron/` as AppImage and deb packages.

### Building all platforms

`npm run electron:build:all` invokes all Electron targets, but it does not create valid cross-platform Node runtimes from a single host. Prefer separate Windows, macOS, and Linux CI jobs. Each job should install dependencies, create its native runtime file, and run its platform-specific build command.

The expected runtime paths are:

```text
Windows: runtime/node.exe
macOS:   runtime/bin/node
Linux:   runtime/bin/node
```

The runtime must be executable and must be produced by the target platform's Node installation. The local development runtime is not automatically portable to other operating systems.

## Verification

```bash
npm run typecheck
npm run lint
npm run build:electron
```

`npm run build:electron` builds both the Next application and the custom server artifact used by Electron.

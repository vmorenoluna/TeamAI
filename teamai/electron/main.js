/**
 * Electron main process for TeamAI.
 *
 * Spawns the Next.js custom server as a child process, waits for it to be ready,
 * then opens a browser window pointing at it. When the window closes, the server
 * is killed and the app exits.
 *
 * In development (ELECTRON_DEV=true), the server runs with tsx watch for HMR.
 * In production (packaged by electron-builder), it runs the production server.
 */
/* eslint-disable @typescript-eslint/no-require-imports */
let mainWindow = null;

const { app, BrowserWindow, shell, session, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const isDev = process.env.ELECTRON_DEV === 'true';
const PORT = 3000;
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;

// Auto-updater (only in production packaged app)
const { autoUpdater } = isDev ? {} : require('electron-updater');

// Prevent second instance — focus existing window instead
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  return;
}

app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

let serverProcess = null;

// ── Server lifecycle ────────────────────────────────────────────────────────

function startServer() {
  return new Promise((resolve, reject) => {
    const projectRoot = path.join(__dirname, '..');

    // In the packaged app, the compiled server entry point and .next/
    // are unpacked from the asar so they're on the real filesystem.
    // The server runs as an Electron child process (no ELECTRON_RUN_AS_NODE)
    // so it retains asar support for resolving node_modules imports.
    // Tradeoff: ~150MB Chromium overhead per server process.
    const unpackedRoot = isDev
      ? projectRoot
      : projectRoot.replace(/app\.asar$/, 'app.asar.unpacked');
    const serverEntry = path.join(unpackedRoot, 'dist-server', 'server.cjs');
    const bundledNode = path.join(unpackedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');

    const env = {
      ...process.env,
      PORT: String(PORT),
      ...(isDev ? {} : {
        NODE_ENV: 'production',
        // NOTE: Not using ELECTRON_RUN_AS_NODE here — the server needs
        // asar support to resolve node_modules imports (next, ws, etc.)
        // from inside the asar archive. Tradeoff: ~150MB Chromium overhead
        // per server process. Optimize later with a standalone Node binary.
      }),
      HOST,
      // Suppress Next.js telemetry in packaged app
      NEXT_TELEMETRY_DISABLED: '1',
    };

    // In dev mode, use tsx watch for HMR; in production, run compiled JS.
    // Pass --with-demo in dev so the demo project is visible for development.
    const args = isDev
      ? [path.join(projectRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'watch', path.join(projectRoot, 'server.ts'), '--with-demo']
      : [serverEntry];

    console.log(`[electron] Starting server: ${args.join(' ')} (cwd: ${unpackedRoot})`);

    const serverExecutable = isDev ? process.execPath : bundledNode;
    serverProcess = spawn(serverExecutable, args, {
      cwd: unpackedRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let resolved = false;

    serverProcess.stdout.on('data', (data) => {
      const output = data.toString();
      process.stdout.write(`[server] ${output}`);
      if (!resolved && output.includes('Ready on')) {
        resolved = true;
        console.log('[electron] Server ready');
        resolve();
      }
    });

    serverProcess.stderr.on('data', (data) => {
      process.stderr.write(`[server:err] ${data.toString()}`);
    });

    serverProcess.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });

    serverProcess.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Server exited with code ${code} before becoming ready`));
      }
    });

    // Fallback: poll the server after 30 seconds
    setTimeout(() => {
      if (!resolved) {
        pollForServer(URL, 30000)
          .then(() => {
            if (!resolved) {
              resolved = true;
              console.log('[electron] Server became available via polling');
              resolve();
            }
          })
          .catch((err) => {
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          });
      }
    }, 30000);
  });
}

function pollForServer(url, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`Server did not respond within ${timeoutMs}ms`));
        return;
      }
      const req = http.get(url, () => {
        resolve();
      });
      req.on('error', () => {
        setTimeout(attempt, 1000);
      });
      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(attempt, 1000);
      });
    };
    attempt();
  });
}

function stopServer() {
  if (serverProcess) {
    console.log('[electron] Stopping server...');
    if (process.platform === 'win32') {
      // On Windows, kill the process tree to ensure tsx watcher children die
      spawn('taskkill', ['/pid', String(serverProcess.pid), '/f', '/t'], {
        stdio: 'ignore',
      });
    } else {
      serverProcess.kill('SIGTERM');
      // SIGKILL after 5s grace period
      setTimeout(() => {
        if (serverProcess && !serverProcess.killed) {
          serverProcess.kill('SIGKILL');
        }
      }, 5000);
    }
    serverProcess = null;
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'TeamAI',
    backgroundColor: '#0b0f19',
    show: false, // show after ready-to-show to prevent white flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
      webSecurity: false, // allow WebSocket connections to local dev server
    },
    autoHideMenuBar: true,
  });

  // Open external links in the system browser, not in the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Expose file-system helpers to the renderer
  ipcMain.handle('show-item-in-folder', (_event, filePath) => {
    shell.showItemInFolder(filePath);
  });

  mainWindow.loadURL(URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  if (isDev) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── App lifecycle ───────────────────────────────────────────────────────────

function setupAutoUpdater() {
  // Always register get-update-status so the renderer can query it on mount.
  // In dev mode it returns false; in production it returns the tracked flag.
  ipcMain.handle('get-update-status', () => ({ updateDownloaded: false }));

  if (!autoUpdater) {
    // Dev mode — register keyboard shortcut to simulate update flow
    if (isDev && mainWindow) {
      mainWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.control && input.shift && input.key === 'U') {
          console.log('[updater:dev] Simulating update flow (Ctrl+Shift+U)');
          simulateUpdateForDev();
        }
      });
    }
    return;
  }

  let updateDownloaded = false;

  // Re-register the handler so it captures the real updateDownloaded variable
  ipcMain.removeHandler('get-update-status');
  ipcMain.handle('get-update-status', () => ({ updateDownloaded }));

  // Log updater events
  autoUpdater.on('checking-for-update', () => console.log('[updater] Checking for update...'));
  autoUpdater.on('update-available', (info) => console.log('[updater] Update available:', info.version));
  autoUpdater.on('update-not-available', () => console.log('[updater] Already up to date'));
  autoUpdater.on('download-progress', (p) => {
    const pct = Math.floor(p.percent);
    console.log(`[updater] Download: ${pct}%`);
    if (mainWindow) mainWindow.webContents.send('download-progress', pct);
  });

  autoUpdater.on('update-downloaded', () => {
    console.log('[updater] Update downloaded — ready to install');
    updateDownloaded = true;
    if (mainWindow) {
      mainWindow.webContents.send('update-ready');
    }
  });
  autoUpdater.on('error', (err) => console.error('[updater] Error:', err.message));

  // Handle install-update IPC from renderer (e.g., user clicks "Install Update")
  ipcMain.on('install-update', () => {
    console.log('[updater] Installing update and restarting...');
    autoUpdater.quitAndInstall();
  });

  // Check for updates 10 seconds after startup (let the server settle)
  setTimeout(() => autoUpdater.checkForUpdates(), 10_000);
}

// Dev-only helper: simulate the update flow (download → ready)
let simulatingUpdate = false;

function simulateUpdateForDev() {
  if (!mainWindow || simulatingUpdate) return;
  simulatingUpdate = true;
  const win = mainWindow; // capture reference — safe if window closes mid-simulation
  let pct = 0;
  const interval = setInterval(() => {
    pct += Math.floor(Math.random() * 15) + 5;
    if (pct >= 100) {
      pct = 100;
      clearInterval(interval);
      setTimeout(() => {
        // Also update the tracked flag so get-update-status returns true
        ipcMain.removeHandler('get-update-status');
        ipcMain.handle('get-update-status', () => ({ updateDownloaded: true }));
        win.webContents.send('update-ready');
        simulatingUpdate = false;
        console.log('[updater:dev] Simulated update-ready');
      }, 400);
    }
    win.webContents.send('download-progress', pct);
  }, 600);
}

app.whenReady().then(async () => {
  // Strip Content-Security-Policy headers so WebSocket connections work in the
  // Electron renderer. Next.js dev server sends CSP headers that can block ws://
  // connections even with webSecurity: false on some Chromium versions.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = { ...details.responseHeaders };
    delete responseHeaders['content-security-policy'];
    delete responseHeaders['content-security-policy-report-only'];
    callback({ responseHeaders });
  });

  try {
    await startServer();
    createWindow();
    setupAutoUpdater();
  } catch (err) {
    console.error('[electron] Failed to start:', err);
    app.quit();
    process.exit(1);
  }
});

// On macOS, re-create window when dock icon is clicked and no windows exist
app.on('activate', () => {
  if (mainWindow === null) {
    // Server is already running (it outlives the window)
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // On macOS, keep the app running in the dock
  if (process.platform !== 'darwin') {
    stopServer();
    app.quit();
  }
});

app.on('before-quit', () => {
  stopServer();
});

app.on('quit', () => {
  stopServer();
});

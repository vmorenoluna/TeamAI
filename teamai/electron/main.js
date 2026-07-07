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
let mainWindow = null;

const { app, BrowserWindow, shell, session } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

const isDev = process.env.ELECTRON_DEV === 'true';
const PORT = 3000;
const HOST = '127.0.0.1';
const URL = `http://${HOST}:${PORT}`;

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

    const args = isDev
      ? ['tsx', 'watch', 'server.ts']
      : ['tsx', 'server.ts'];

    const env = {
      ...process.env,
      ...(isDev ? {} : { NODE_ENV: 'production' }),
      HOST,
      // Suppress Next.js telemetry in packaged app
      NEXT_TELEMETRY_DISABLED: '1',
    };

    console.log(`[electron] Starting server: npx ${args.join(' ')} (cwd: ${projectRoot})`);

    serverProcess = spawn('npx', args, {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
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
      webSecurity: false, // allow WebSocket connections to local dev server
    },
    autoHideMenuBar: true,
  });

  // Open external links in the system browser, not in the app window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
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

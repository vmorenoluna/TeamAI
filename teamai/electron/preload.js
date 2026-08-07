/* eslint-disable @typescript-eslint/no-require-imports */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  /** Check if an update was already downloaded (for persistence across page navigations). */
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  /** Listen for an available update from the main process. */
  onUpdateReady: (callback) => {
    ipcRenderer.on('update-ready', (_event) => callback());
  },
  /** Remove update-ready listener. */
  removeUpdateReadyListener: () => {
    ipcRenderer.removeAllListeners('update-ready');
  },
  /** Listen for download progress updates (0-100). */
  onDownloadProgress: (callback) => {
    ipcRenderer.on('download-progress', (_event, percent) => callback(percent));
  },
  /** Remove download-progress listener. */
  removeDownloadProgressListener: () => {
    ipcRenderer.removeAllListeners('download-progress');
  },
  /** Trigger quit-and-install for a downloaded update. */
  installUpdate: () => {
    ipcRenderer.send('install-update');
  },
  /** Open the file manager at the given file/folder path. */
  showItemInFolder: (filePath) => ipcRenderer.invoke('show-item-in-folder', filePath),
});

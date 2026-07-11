export {};

declare global {
  interface Window {
    electronAPI?: {
      getUpdateStatus: () => Promise<{ updateDownloaded: boolean }>;
      onUpdateReady: (callback: () => void) => void;
      removeUpdateReadyListener: () => void;
      onDownloadProgress: (callback: (percent: number) => void) => void;
      removeDownloadProgressListener: () => void;
      installUpdate: () => void;
    };
  }
}

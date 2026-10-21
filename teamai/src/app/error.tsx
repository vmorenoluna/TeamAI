'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex items-center justify-center h-full p-6">
      <div
        role="alert"
        className="max-w-md p-4 bg-red-900/30 border border-red-800/50 rounded-lg"
      >
        <p className="text-sm font-semibold text-red-300 mb-1">Could not load this page</p>
        <p className="text-xs text-red-400">{error.message}</p>
        {error.digest && <p className="text-[11px] text-slate-500 mt-2">Digest: {error.digest}</p>}
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-3 px-3 py-1 text-xs rounded bg-red-800/50 text-red-200 hover:bg-red-800/70"
        >
          Reload
        </button>
      </div>
    </div>
  );
}

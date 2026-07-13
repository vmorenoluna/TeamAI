'use client';

import { useState, useCallback } from 'react';

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="text-xs px-2 py-1 rounded border border-[#334155] text-slate-400 hover:text-white hover:border-[#475569] transition-colors"
      title={`Copy ${label || 'content'} to clipboard`}
    >
      {copied ? '✓ Copied' : '📋 Copy'}
    </button>
  );
}

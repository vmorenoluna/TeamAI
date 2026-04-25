import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

export function usePhaseSync() {
  const router = useRouter();

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'phase-change') {
          router.refresh();
        }
      } catch {
        // ignore malformed messages
      }
    };
    return () => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [router]);
}

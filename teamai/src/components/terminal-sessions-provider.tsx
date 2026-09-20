'use client';

import { createContext, useContext, useState, useTransition } from 'react';
import { createTerminalSession, closeTerminalSession } from '@/app/actions/terminals';

export interface ActiveTerminal {
  sessionId: string;
  role: string;
  model: string;
}

interface TerminalSessionsContextValue {
  terminals: ActiveTerminal[];
  isPending: boolean;
  openTerminal: (role: string) => void;
  closeTerminal: (sessionId: string) => void;
}

const TerminalSessionsContext = createContext<TerminalSessionsContextValue | null>(null);

export function TerminalSessionsProvider({
  initialTerminals,
  children,
}: {
  initialTerminals: ActiveTerminal[];
  children: React.ReactNode;
}) {
  const [terminals, setTerminals] = useState(initialTerminals);
  const [isPending, startTransition] = useTransition();

  function openTerminal(role: string) {
    startTransition(async () => {
      const terminal = await createTerminalSession(role);
      setTerminals(prev => [...prev, {
        sessionId: terminal.sessionId,
        role: terminal.role,
        model: terminal.model,
      }]);
    });
  }

  function closeTerminal(sessionId: string) {
    closeTerminalSession(sessionId).catch(err => {
      console.warn('[terminal-sessions] Failed to close session:', err);
    });
    setTerminals(prev => prev.filter(t => t.sessionId !== sessionId));
  }

  return (
    <TerminalSessionsContext.Provider value={{ terminals, isPending, openTerminal, closeTerminal }}>
      {children}
    </TerminalSessionsContext.Provider>
  );
}

export function useTerminalSessions(): TerminalSessionsContextValue {
  const context = useContext(TerminalSessionsContext);
  if (!context) {
    throw new Error('useTerminalSessions must be used within TerminalSessionsProvider');
  }
  return context;
}

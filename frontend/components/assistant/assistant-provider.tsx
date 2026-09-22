"use client";

/**
 * Open/closed state for the assistant panel (AS-4).
 *
 * A client context so the topbar trigger and the panel column share one flag
 * while AppShell stays a server component — the provider renders its server
 * children untouched through `{children}`. Transcript state lives in the
 * panel (use-assistant-chat), not here: closing the panel must not clear it,
 * but nothing outside the panel needs to read it either.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface AssistantPanelState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const AssistantContext = createContext<AssistantPanelState | null>(null);

interface AssistantProviderProps {
  children: ReactNode;
  /** Test hook — lets component tests render the panel already open. */
  defaultOpen?: boolean;
}

export function AssistantProvider({ children, defaultOpen = false }: AssistantProviderProps) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((previous) => !previous), []);
  const value = useMemo(() => ({ open, setOpen, toggle }), [open, toggle]);
  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

export function useAssistantPanel(): AssistantPanelState {
  const context = useContext(AssistantContext);
  if (context === null) {
    throw new Error("useAssistantPanel must be used inside <AssistantProvider>");
  }
  return context;
}

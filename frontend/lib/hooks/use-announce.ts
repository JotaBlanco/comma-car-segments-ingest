"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * ONE polite live region for the whole app (FR-DM-091).
 *
 * Loading, filtering, sorting and paging changed the page silently — a
 * screen reader heard nothing. Every announcement funnels through this one
 * `role="status"` region: one region cannot double-announce, and there is
 * no scattered aria-live markup to drift.
 *
 * Debounced trailing-edge: a filter click fires a fetch, the fetch settles,
 * the pager range changes — only the LAST message inside the window is
 * spoken, so a burst of state changes reads as one sentence.
 */

const ANNOUNCE_DEBOUNCE_MS = 400;

type Announce = (message: string) => void;

const AnnounceContext = createContext<Announce | null>(null);

export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSpoken = useRef("");

  const announce = useCallback<Announce>((next) => {
    /* Dedupe: a table that remounts on every fetch (react-query drops `data`
       while a new key loads) re-announces its unchanged range on every
       render. The same text twice adds nothing — skip it. */
    if (next === lastSpoken.current && timer.current === null) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      lastSpoken.current = next;
      setMessage(next);
    }, ANNOUNCE_DEBOUNCE_MS);
  }, []);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    []
  );

  const region = createElement(
    "div",
    { role: "status", "aria-live": "polite", className: "sr-only" },
    message
  );

  return createElement(AnnounceContext.Provider, { value: announce }, children, region);
}

/**
 * The app-wide announcer. Outside the provider (isolated component tests) it
 * is a no-op, so a table can render without the shell.
 */
export function useAnnounce(): Announce {
  const announce = useContext(AnnounceContext);
  return useMemo(() => announce ?? (() => undefined), [announce]);
}

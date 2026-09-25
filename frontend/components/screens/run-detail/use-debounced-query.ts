"use client";

import { useEffect, useState } from "react";

/** Keystroke-to-request debounce for a picker's `?q=` search. */
export const PICKER_SEARCH_DEBOUNCE_MS = 250;

/**
 * The typed picker text, trailing-edge debounced into a `?q=` value.
 *
 * The work-order picker in `edit-run-dialog.tsx` searches server-side, so one
 * keystroke must not become one request.
 */
export function useDebouncedQuery(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

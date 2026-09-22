"use client";

import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Debounced search input.
 *
 * - Local state mirrors keystrokes; `onDebouncedChange` fires 140 ms after the last keypress
 *   (spec §2.2 allows ~120–150; 140 splits the mock's 120 and gives the server round-trip
 *   a touch more breathing room).
 * - When `value` changes externally (URL cleared, pill removed, browser back) the local
 *   state resyncs — the effect below is the sync point.
 * - Rendered as `type="search"`, `aria-label={placeholder}` so it is discoverable by a11y
 *   tools even though the placeholder acts as the visible label in the mock.
 */

export interface TableSearchInputProps {
  /** Canonical value from the URL. */
  readonly value: string;
  /** Fires after ~140 ms idle. */
  readonly onDebouncedChange: (value: string) => void;
  readonly placeholder: string;
  readonly className?: string;
  /** Override the debounce for tests. */
  readonly debounceMs?: number;
}

export function TableSearchInput({
  value,
  onDebouncedChange,
  placeholder,
  className,
  debounceMs = 140,
}: TableSearchInputProps) {
  const [local, setLocal] = useState(value);
  const lastCommitted = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // External sync: when the URL value changes (and it is different from what we last emitted),
  // adopt it. Guarded by `lastCommitted` so our own debounced emissions don't clobber the
  // input mid-typing when the URL then reflects them back.
  useEffect(() => {
    if (value !== lastCommitted.current) {
      setLocal(value);
      lastCommitted.current = value;
    }
  }, [value]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) clearTimeout(timer.current);
    };
  }, []);

  const handleChange = (next: string) => {
    setLocal(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      lastCommitted.current = next;
      onDebouncedChange(next);
    }, debounceMs);
  };

  return (
    <label
      className={cn(
        "flex w-[230px] items-center gap-2 rounded-md border border-input bg-surface px-2.5 py-1.5 text-ink-3 transition-colors focus-within:border-primary focus-within:ring-1 focus-within:ring-ring/40",
        className
      )}
    >
      <SearchIcon aria-hidden className="size-3.5 shrink-0" />
      <input
        type="search"
        value={local}
        onChange={(event) => handleChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full bg-transparent text-[0.78rem] text-ink outline-none placeholder:text-ink-3"
      />
    </label>
  );
}

"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A text filter that matches the stored value by substring — "Revision" and
 * "Related to" on this screen, where `ExactFilterInput`'s exact-match rule
 * would be wrong (a person filtering `related_reqs` types a partial id).
 *
 * Applies on Enter and on blur, never per keystroke, the same reasoning
 * `ExactFilterInput` states: a half-typed value can only ever narrow further,
 * so applying mid-type would refetch on every letter for no answer a person
 * asked for yet.
 */
export interface ContainsFilterInputProps {
  readonly label: string;
  readonly value: string;
  readonly onApply: (value: string) => void;
  readonly placeholder?: string;
  readonly inputClassName?: string;
}

export function ContainsFilterInput({
  label,
  value,
  onApply,
  placeholder,
  inputClassName,
}: ContainsFilterInputProps) {
  const inputId = useId();
  const hintId = useId();
  const [local, setLocal] = useState(value);
  const lastApplied = useRef(value);

  useEffect(() => {
    if (value !== lastApplied.current) {
      setLocal(value);
      lastApplied.current = value;
    }
  }, [value]);

  const apply = () => {
    const trimmed = local.trim();
    if (trimmed === lastApplied.current) return;
    lastApplied.current = trimmed;
    onApply(trimmed);
  };

  return (
    <div className="flex max-w-full items-center gap-1.5">
      <label htmlFor={inputId} className="flex-none text-[0.72rem] text-ink-3">
        {label}
      </label>
      <input
        id={inputId}
        type="text"
        value={local}
        placeholder={placeholder}
        aria-describedby={hintId}
        onChange={(event) => setLocal(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === "Enter") apply();
        }}
        className={cn(
          "h-7 w-[160px] min-w-0 rounded-md border border-line bg-surface px-2 text-[0.78rem] text-ink outline-none transition-colors placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
          inputClassName,
        )}
      />
      <span id={hintId} className="sr-only">
        Matches any requirement whose value contains this text. Press Enter to apply.
      </span>
    </div>
  );
}

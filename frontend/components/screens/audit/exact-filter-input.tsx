"use client";

import { useEffect, useId, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A text filter that matches the stored value exactly.
 *
 * `GET /journal` matches `field`, `actor` and `entity_id` exactly — the route
 * says so itself: a substring match would make `actor=a` name half the staff.
 * A plain search box hides that rule. A person types half a value, reads an
 * empty table and concludes the journal lost their entry.
 *
 * This input refuses to fire on a half-typed value:
 *
 * - The label is visible text, never a placeholder.
 * - The described-by hint spells the exact-match rule out for a screen
 *   reader. The visible rule lives once on the group in the audit panel,
 *   not as a tag on every input.
 * - The value applies on Enter and on blur, never per keystroke. An exact
 *   match over a half-typed value can only answer nothing, so applying while
 *   a person still types would flash the empty state at every letter.
 */

export interface ExactFilterInputProps {
  /** The visible name: "Field", "Actor", "Entity id". */
  readonly label: string;
  /** The applied value, from the URL. "" means the filter is off. */
  readonly value: string;
  /** Fires with the trimmed value on Enter or blur, only when it changed. */
  readonly onApply: (value: string) => void;
  /** An example value, e.g. "run.operator". The label stays the name. */
  readonly placeholder?: string;
  /** Classes for the input, e.g. a width. */
  readonly inputClassName?: string;
}

export function ExactFilterInput({
  label,
  value,
  onApply,
  placeholder,
  inputClassName,
}: ExactFilterInputProps) {
  const inputId = useId();
  const hintId = useId();
  const [local, setLocal] = useState(value);
  const lastApplied = useRef(value);

  /* A removed pill or a cleared filter changes `value` from outside, and the
     box must follow it. `lastApplied` keeps our own commit from clobbering
     what a person types next, the way `TableSearchInput` guards its sync. */
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
      {/* h-7, like every control in the filter strip. */}
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
          "h-7 w-[168px] min-w-0 rounded-md border border-line bg-surface px-2 font-mono text-[0.78rem] text-ink outline-none transition-colors placeholder:font-sans placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50",
          inputClassName,
        )}
      />
      <span id={hintId} className="sr-only">
        Matches the stored value exactly. Press Enter to apply.
      </span>
    </div>
  );
}

"use client";

import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

/**
 * Multi-select filter with a Popover of Checkbox rows (spec §2.3).
 *
 * - Trigger renders label + a count pill when any values are selected; applied styling
 *   (`accent-soft` background, primary border) mirrors the mock's `.fbtn.applied`.
 * - An empty option list states so; the caller may derive the options from the loaded rows.
 * - `emptyText` replaces that line when the caller does not derive the options from the rows.
 * - `note` states what the derived list covers, so a partial list never reads as complete.
 * - Checkbox toggles call `onChange` immediately (apply-on-click — the mock has no
 *   "Apply" step); the footer only carries `Clear` (empties selection) and `Done` (closes).
 * - Base-UI Popover handles Escape-to-close + focus return; we set `aria-haspopup="dialog"`
 *   and toggle `aria-expanded` on the trigger for AT clarity.
 * - Past `SEARCH_THRESHOLD` options a search box appears atop the list
 *   (client-side substring, FR-DM-079a). It narrows what is VISIBLE only —
 *   the selection semantics and the URL state stay untouched, and a selected
 *   value hidden by the search stays selected.
 */

/** Options up to this count fit one popover without scanning; more get search. */
const SEARCH_THRESHOLD = 8;

/** Substring match over the value and, when it is a string, the label. */
function matchesQuery(option: FilterOption, query: string): boolean {
  const needle = query.toLowerCase();
  if (option.value.toLowerCase().includes(needle)) return true;
  return typeof option.label === "string" && option.label.toLowerCase().includes(needle);
}

export interface FilterOption {
  readonly value: string;
  /** Label may be a string or a badge/mono span node. */
  readonly label: ReactNode;
  /**
   * The value in plain words. A badge label leaves the checkbox named by the
   * raw wire value, and a reader cannot decode that. This joins the name.
   */
  readonly description?: string;
}

export interface MultiSelectFilterProps {
  readonly label: string;
  readonly options: readonly FilterOption[];
  /** One line under the options. Say what a derived list covers. */
  readonly note?: string;
  /** The line the popover shows when the option list is empty. */
  readonly emptyText?: string;
  readonly selected: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
  readonly className?: string;
}

export function MultiSelectFilter({
  label,
  options,
  note,
  emptyText = "No values in the loaded rows.",
  selected,
  onChange,
  className,
}: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const applied = selected.length > 0;
  const selectedSet = new Set(selected);

  const searchable = options.length > SEARCH_THRESHOLD;
  const trimmedQuery = query.trim();
  const visibleOptions =
    searchable && trimmedQuery.length > 0
      ? options.filter((option) => matchesQuery(option, trimmedQuery))
      : options;

  const openChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    // A reopened popover shows the whole list again, never a stale search.
    if (!nextOpen) setQuery("");
  };

  const toggle = (value: string) => {
    if (selectedSet.has(value)) {
      onChange(selected.filter((v) => v !== value));
    } else {
      onChange([...selected, value]);
    }
  };

  const clear = () => onChange([]);

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        aria-haspopup="dialog"
        aria-expanded={open}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-[0.76rem] font-semibold transition-colors",
          applied
            ? "border-primary bg-accent-soft text-primary"
            : "border-input bg-surface text-ink-2 hover:border-line-strong",
          className
        )}
      >
        <span>{label}</span>
        {applied && (
          <span
            aria-label={`${selected.length} selected`}
            className="rounded-lg bg-accent-fill px-1.5 font-mono text-[0.64rem] leading-[1.5] text-primary-foreground"
          >
            {selected.length}
          </span>
        )}
        <ChevronDownIcon aria-hidden className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-56 gap-0 p-1.5"
        aria-label={`${label} filter`}
      >
        <div className="px-2 py-1 text-[0.62rem] font-bold tracking-[0.08em] text-ink-3 uppercase">
          {label}
        </div>
        {searchable && (
          <div className="px-1 pb-1">
            <input
              type="search"
              value={query}
              aria-label={`Search ${label.toLowerCase()} options`}
              placeholder="Search options…"
              className="h-7 w-full rounded-md border border-input bg-surface px-2 text-[0.76rem] outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        )}
        <div className="flex max-h-64 flex-col overflow-y-auto">
          {options.length === 0 && (
            <div className="px-2 py-1.5 text-[0.74rem] text-ink-3">{emptyText}</div>
          )}
          {options.length > 0 && visibleOptions.length === 0 && (
            <div className="px-2 py-1.5 text-[0.74rem] text-ink-3">
              No option matches “{trimmedQuery}”.
            </div>
          )}
          {visibleOptions.map((option) => {
            const checked = selectedSet.has(option.value);
            const name = typeof option.label === "string" ? option.label : option.value;
            return (
              <label
                key={option.value}
                className="group/field flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-[0.78rem] hover:bg-surface-2"
              >
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => toggle(option.value)}
                  aria-label={option.description ? `${name}. ${option.description}` : name}
                />
                <span className="flex-1">{option.label}</span>
              </label>
            );
          })}
        </div>
        {note !== undefined && (
          <div className="mt-1 border-t border-line-2 px-2 pt-1.5 text-[0.68rem] leading-snug text-ink-3">
            {note}
          </div>
        )}
        <div className="mt-1 flex items-center justify-between border-t border-line-2 px-2 pt-2 pb-1">
          <button
            type="button"
            onClick={clear}
            disabled={!applied}
            className="text-[0.7rem] font-semibold text-ink-3 hover:text-ink-2 disabled:cursor-default disabled:opacity-40"
          >
            Clear
          </button>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-[0.7rem] font-semibold text-primary hover:text-accent-fill-hover"
          >
            Done
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

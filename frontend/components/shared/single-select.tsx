"use client";

import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * One choice from a list, drawn the way this app draws its dropdowns.
 *
 * This is the app's stand-in for the native `<select>`. The native element
 * draws the operating system's own chrome: its own font, its own chevron, and
 * no dark theme. This wrapper keeps the native element's shape — a label,
 * options or groups, one value, one change — so replacing a `<select>` is a
 * small edit at the call site.
 *
 * The trigger copies the Unit and Rate filter pills in
 * `components/shared/multi-select-filter.tsx`. The popup and the keyboard work
 * — arrows, typeahead, Enter, Escape-to-close, focus return — come from
 * `components/ui/select` (Base UI), not from code here.
 */

export interface SingleSelectOption {
  readonly value: string;
  /** The words a person reads, in the popup and on the closed trigger. */
  readonly label: string;
  /** A disabled option stays visible and refuses the pick. */
  readonly disabled?: boolean;
}

export interface SingleSelectGroup {
  /** The heading over the group, e.g. "Deployments". */
  readonly label: string;
  readonly options: readonly SingleSelectOption[];
}

export interface SingleSelectProps {
  /** The control's name. It names the trigger for assistive tech too. */
  readonly label: string;
  /** Keep the label for screen readers only. The name must still be real. */
  readonly labelHidden?: boolean;
  /** The picked value, or null while nothing is picked. */
  readonly value: string | null;
  readonly onChange: (value: string) => void;
  /** The line the closed trigger shows while nothing is picked. */
  readonly placeholder?: string;
  /** Flat options. Use `groups` instead when the options need headings. */
  readonly options?: readonly SingleSelectOption[];
  /** Grouped options. An empty group renders nothing at all. */
  readonly groups?: readonly SingleSelectGroup[];
  readonly disabled?: boolean;
  /** Classes for the wrapper around the label and the trigger. */
  readonly className?: string;
  /** Classes for the trigger itself, e.g. a width cap. */
  readonly triggerClassName?: string;
}

/* The filter-pill look from MultiSelectFilter's trigger. The base trigger in
   components/ui/select keeps its focus ring, its disabled state and its
   height; these classes replace only the skin, via tailwind-merge. */
const TRIGGER_SKIN =
  "gap-2 rounded-md border-input bg-surface px-3 text-[0.76rem] font-semibold " +
  "text-ink-2 hover:border-line-strong dark:bg-surface dark:hover:bg-surface " +
  "[&_svg]:size-3! [&_svg]:text-current [&_svg]:opacity-60";

export function SingleSelect({
  label,
  labelHidden = false,
  value,
  onChange,
  placeholder = "Choose…",
  options,
  groups,
  disabled = false,
  className,
  triggerClassName,
}: SingleSelectProps) {
  const labelId = useId();

  /* One shape inside: a list of groups. Flat options become one unnamed
     group, which renders with no heading. */
  const grouped: readonly SingleSelectGroup[] = groups ?? [
    { label: "", options: options ?? [] },
  ];
  /* Base UI resolves the trigger's text from this list, so the closed
     trigger shows the option's label and never the raw value. */
  const items = grouped.flatMap((group) =>
    group.options.map((option) => ({ value: option.value, label: option.label })),
  );

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        id={labelId}
        className={cn("text-[0.76rem] text-ink-3", labelHidden && "sr-only")}
      >
        {label}
      </span>
      <Select
        items={items}
        value={value}
        onValueChange={(next: unknown) => {
          if (typeof next === "string") onChange(next);
        }}
        disabled={disabled}
      >
        <SelectTrigger
          size="sm"
          aria-labelledby={labelId}
          className={cn(TRIGGER_SKIN, triggerClassName)}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        {/* The popup opens under the trigger, the way the filter popovers do,
            instead of Base UI's macOS-style overlay on the trigger. */}
        <SelectContent align="start" sideOffset={6} alignItemWithTrigger={false}>
          {grouped.map((group) =>
            group.options.length === 0 ? null : (
              <SelectGroup key={group.label}>
                {group.label.length > 0 && <SelectLabel>{group.label}</SelectLabel>}
                {group.options.map((option) => (
                  <SelectItem
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled === true}
                  >
                    {option.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            ),
          )}
        </SelectContent>
      </Select>
    </div>
  );
}

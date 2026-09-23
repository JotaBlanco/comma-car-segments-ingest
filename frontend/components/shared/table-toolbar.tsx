"use client";

/**
 * The two-tier toolbar every list screen wears.
 *
 * One flat row of eight or ten equal controls reads as noise, and it wraps:
 * the trailing controls drop to the start of a second line and look orphaned
 * there. So the row carries only what a person touches on nearly every visit —
 * which subset, free text, and the actions — and everything else lives one
 * click away in a panel below.
 *
 * Collapsing is only safe because `ActiveFilterPills` sits under this on every
 * screen that uses it, naming each filter that is on whether the panel is open
 * or shut. A shut panel therefore hides controls, never state. `useDisclosure`
 * adds the second guard: a URL that already carries a filter opens the panel
 * on arrival, so a link a colleague pastes shows the filters it applies.
 *
 * A screen whose panel is too tall to push the table down puts the same
 * controls in an overlay instead and skips `useDisclosure` — `requirements`
 * does, through `toolbarTriggerClass` and `FiltersTriggerContent` below, so
 * its Filters control still looks and counts exactly like this one.
 */

import { useId, useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Open/shut state for the options panel.
 *
 * `useState` with an initialiser, not an effect: `activeCount` decides the
 * FIRST paint only. An effect would re-shut a panel the reader had since
 * opened every time a filter count changed.
 */
export function useDisclosure(activeCount: number) {
  const id = useId();
  const [open, setOpen] = useState(() => activeCount > 0);
  return {
    id,
    open,
    activeCount,
    toggle: () => setOpen((current) => !current),
  };
}

export type Disclosure = ReturnType<typeof useDisclosure>;

/**
 * The always-on row: scope and search on the left, actions on the right.
 *
 * `justify-between` holds the two apart, and there is deliberately NO spacer
 * element. A `flex-1` spacer inside a wrapping row eats the first line and
 * drops the trailing controls to the LEFT of the second one. Each side wraps
 * inside itself instead, so the action cluster always moves as one piece and
 * always stays right-aligned.
 */
export function ToolbarRow({
  children,
  actions,
}: {
  readonly children: ReactNode;
  readonly actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">{children}</div>
      {actions !== undefined && (
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
    </div>
  );
}

/** The skin every toolbar trigger wears — the panel button, a popover trigger,
    a menu trigger. `active` is "this control is open or is holding state". */
export function toolbarTriggerClass(active: boolean, className?: string): string {
  return cn(
    "inline-flex flex-none items-center gap-[6px] rounded-md border border-border px-[11px] py-[5px] text-[0.76rem] font-semibold transition-colors",
    "hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
    active ? "bg-surface-2 text-ink" : "bg-surface text-ink-2",
    className,
  );
}

/**
 * What a Filters trigger says: the icon, the label, the count of what is on,
 * and the chevron.
 *
 * The count is what keeps a shut panel honest at a glance. It follows the
 * quick-view segment's badge — mono, one step down, `text-ink-3` at rest —
 * because `--color-accent-foreground` aliases `--accent`, so an accent-on-accent
 * pill would paint itself invisible.
 */
export function FiltersTriggerContent({
  open,
  activeCount,
  label = "Filters",
}: {
  readonly open: boolean;
  readonly activeCount: number;
  readonly label?: string;
}) {
  return (
    <>
      <SlidersHorizontal className="size-[13px]" strokeWidth={2.2} />
      {label}
      {activeCount > 0 && (
        <span className={cn("ml-px font-mono text-[0.68rem]", open ? "text-ink" : "text-ink-3")}>
          {activeCount}
        </span>
      )}
      <ChevronDown
        aria-hidden="true"
        className={cn("size-[12px] opacity-60 transition-transform", open && "rotate-180")}
        strokeWidth={2.2}
      />
    </>
  );
}

/** The button that opens the options panel, with a count of what is on. */
export function ToolbarFiltersButton({
  disclosure,
  label = "Filters",
}: {
  readonly disclosure: Disclosure;
  readonly label?: string;
}) {
  const { open, activeCount, id, toggle } = disclosure;
  return (
    <button
      type="button"
      onClick={toggle}
      aria-expanded={open}
      aria-controls={id}
      className={toolbarTriggerClass(open)}
    >
      <FiltersTriggerContent open={open} activeCount={activeCount} label={label} />
    </button>
  );
}

/** The revealed panel. Renders nothing while shut, so nothing is tabbable. */
export function ToolbarPanel({
  disclosure,
  children,
}: {
  readonly disclosure: Disclosure;
  readonly children: ReactNode;
}) {
  if (!disclosure.open) return null;
  return (
    <div
      id={disclosure.id}
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-line bg-surface-2/40 px-3 py-2.5"
    >
      {children}
    </div>
  );
}

/**
 * The hairline between one group of controls and the next.
 *
 * Decoration, so it carries `aria-hidden`: the grouping it draws is already in
 * the DOM order and in each control's own label. It hides once the row wraps,
 * because a rule between two stacked lines points at nothing.
 */
export function ToolbarDivider() {
  return <span aria-hidden="true" className="mx-0.5 hidden h-4 w-px flex-none bg-line md:block" />;
}

/** The small caps naming a group inside the panel. */
export function ToolbarGroupLabel({ children }: { readonly children: string }) {
  return (
    <span className="select-none text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-ink-3">
      {children}
    </span>
  );
}

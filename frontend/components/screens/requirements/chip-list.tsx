import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One rule for every multi-valued cell on this page (verified_by, system
 * states, measurands, source tags, related requirements): show the first
 * `max`, then a `+N` marker for the rest. List cells default to 2 — a cell
 * holding twenty chips sets the row height of the whole table. Detail
 * panels pass a higher `max` (or `Infinity`) because there is one
 * requirement and room for them.
 */
export interface ChipListProps<T> {
  readonly items: readonly T[];
  readonly max?: number;
  readonly renderItem: (item: T, index: number) => ReactNode;
  readonly keyOf?: (item: T, index: number) => string;
  readonly emptyLabel?: ReactNode;
  readonly className?: string;
}

export function ChipList<T>({
  items,
  max = 2,
  renderItem,
  keyOf,
  emptyLabel = "—",
  className,
}: ChipListProps<T>) {
  if (items.length === 0) {
    return <span className={cn("text-[0.78rem] text-ink-3", className)}>{emptyLabel}</span>;
  }
  const shown = items.slice(0, max);
  const overflow = items.length - shown.length;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((item, index) => (
        <span key={keyOf ? keyOf(item, index) : index}>{renderItem(item, index)}</span>
      ))}
      {overflow > 0 && (
        <span className="font-mono text-[0.68rem] text-ink-3">+{overflow}</span>
      )}
    </span>
  );
}

/** A mono chip in a neutral pill — the shape a td id, a stakeholder tag or a
    related-requirement id renders in, on the list and on the detail alike. */
export function MonoChip({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm bg-muted px-[5px] py-px font-mono text-[0.7rem] text-ink-2",
        className,
      )}
    >
      {children}
    </span>
  );
}

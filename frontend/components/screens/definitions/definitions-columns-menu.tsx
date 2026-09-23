"use client";

import { Columns3, RotateCcw } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toolbarTriggerClass } from "@/components/shared/table-toolbar";
import { setHiddenColumns } from "./definitions-column-visibility";
import { DEFINITION_COLUMNS } from "./definitions-columns";

/**
 * Which columns the test definitions grid draws. The choice is this browser's
 * (see `definitions-column-visibility.ts`) and it changes the TABLE only.
 *
 * A pinned column shows its tick disabled rather than vanishing from the list,
 * so a person hunting for "Definition" finds it and learns why it cannot go.
 */
export function DefinitionsColumnsMenu({ hidden }: { readonly hidden: readonly string[] }) {
  const hiddenSet = new Set(hidden);
  const shown = DEFINITION_COLUMNS.filter(
    (column) => column.pinned === true || !hiddenSet.has(column.id),
  ).length;

  const toggle = (id: string) => {
    setHiddenColumns(
      hiddenSet.has(id) ? hidden.filter((hiddenId) => hiddenId !== id) : [...hidden, id],
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Columns — ${shown} of ${DEFINITION_COLUMNS.length} shown`}
        className={toolbarTriggerClass(hidden.length > 0)}
      >
        <Columns3 className="size-[13px]" strokeWidth={2.2} />
        Columns
        {hidden.length > 0 && (
          <span className="ml-px font-mono text-[0.68rem] text-ink-3">
            {`${shown}/${DEFINITION_COLUMNS.length}`}
          </span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-[70vh] min-w-56 overflow-y-auto">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Columns in the table</DropdownMenuLabel>
          {DEFINITION_COLUMNS.map((column) => {
            const pinned = column.pinned === true;
            const visible = pinned || !hiddenSet.has(column.id);
            return (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={visible}
                disabled={pinned}
                // Ticking columns is a multi-step act, so the menu stays open
                // across ticks.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={() => toggle(column.id)}
                // Hide the primitive's trailing tick: it draws nothing when
                // clear, and the box below is drawn in both states.
                className="gap-2.5 pr-2 pl-2 [&_[data-slot=dropdown-menu-checkbox-item-indicator]]:hidden"
              >
                <Checkbox
                  checked={visible}
                  aria-hidden="true"
                  tabIndex={-1}
                  className="pointer-events-none"
                />
                <span className="flex-1">{column.label}</span>
                {pinned && <span className="text-[0.66rem] text-ink-3">always</span>}
              </DropdownMenuCheckboxItem>
            );
          })}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem disabled={hidden.length === 0} onClick={() => setHiddenColumns([])}>
          <RotateCcw className="size-[13px]" strokeWidth={2.2} />
          Show all columns
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

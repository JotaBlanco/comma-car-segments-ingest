"use client";

import { Compass, LayoutDashboard, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { exploreHref, type ExploreEntry } from "@/lib/explore/entry";
import { cn } from "@/lib/utils";
import { createWorkbook, useWorkbooks, workbookHref } from "@/lib/workbooks";

/**
 * "Open in a workbook": the saved station dashboards, each opened on this run
 * and, from an issue, on its signal and period, and the Explorer among the
 * choices when an entry for it is given. The station runs inside the Test
 * Manager, so this needs no station URL to show.
 */
export function WorkbookMenu({
  run,
  signals = [],
  frame = null,
  issue = null,
  explore = null,
  iconOnly = false,
  label = "Open in a workbook",
}: {
  run: string | null;
  signals?: readonly string[];
  frame?: { t0_ms: number; t1_ms: number } | null;
  /** The issue's lake snippet id: the workbook ticks it on arrival. */
  issue?: number | null;
  /** Offer the Explorer too, on this. */
  explore?: ExploreEntry | null;
  iconOnly?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const workbooks = useWorkbooks();
  const open = (id: string) => router.push(workbookHref(id, { run, signals, frame, issue }));
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          buttonVariants({
            variant: iconOnly ? "ghost" : "outline",
            size: iconOnly ? "icon-xs" : "sm",
          }),
          !iconOnly && "font-semibold",
        )}
        aria-label={label}
        title={label}
        onClick={(e) => e.stopPropagation()}
      >
        <LayoutDashboard />
        {!iconOnly && label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        {explore !== null && (
          <>
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={() => router.push(exploreHref(explore))}>
                <Compass /> Explorer
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuGroup>
          <DropdownMenuLabel>Workbooks</DropdownMenuLabel>
          {workbooks.length === 0 && (
            <DropdownMenuItem disabled>No workbooks saved yet</DropdownMenuItem>
          )}
          {workbooks.map((w) => (
            <DropdownMenuItem key={w.id} onClick={() => open(w.id)}>
              {w.name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            const w = createWorkbook("New workbook");
            if (w !== null) open(w.id);
          }}
        >
          <Plus /> New workbook
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

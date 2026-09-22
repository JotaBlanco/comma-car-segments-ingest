"use client";

import { useState } from "react";
import { ChevronDown, ListChecks, Timer } from "lucide-react";
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
import { cn } from "@/lib/utils";
import { setWorkbookSessions, workbookHref, type Workbook } from "@/lib/workbooks";
import { SessionsDialog } from "./sessions-dialog";

/**
 * Which session the workbook shows: a dropdown over the runs ticked for it, and the
 * dialog that ticks them. Picking one reopens the station on that run.
 */
export function SessionMenu({ workbook, run }: { workbook: Workbook; run: string | null }) {
  const router = useRouter();
  const [choosing, setChoosing] = useState(false);
  const sessions = workbook.sessions;
  const label = run ?? (sessions.length === 0 ? "No session" : "Choose a session");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-w-[22rem] font-mono")}
          aria-label="Session"
          title="The test run this workbook shows"
        >
          <Timer />
          <span className="min-w-0 truncate">{label}</span>
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="max-h-[60dvh] w-[24rem] overflow-auto">
          <DropdownMenuGroup>
            <DropdownMenuLabel>Sessions</DropdownMenuLabel>
            {sessions.length === 0 && (
              <DropdownMenuItem disabled>No sessions picked for this workbook</DropdownMenuItem>
            )}
            {sessions.map((s) => (
              <DropdownMenuItem
                key={s}
                className="font-mono text-[0.78rem]"
                aria-current={s === run ? "true" : undefined}
                onClick={() => router.push(workbookHref(workbook.id, { run: s }))}
              >
                <Timer className={cn(s !== run && "opacity-40")} />
                {s}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setChoosing(true)}>
            <ListChecks /> Choose sessions…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {choosing && (
        <SessionsDialog
          selected={sessions}
          onChange={(next) => setWorkbookSessions(workbook.id, next)}
          onClose={() => {
            setChoosing(false);
            // The first session picked opens by itself when nothing is open yet.
            const first = workbook.sessions[0];
            if (run === null && first !== undefined) {
              router.push(workbookHref(workbook.id, { run: first }));
            }
          }}
        />
      )}
    </>
  );
}

"use client";

import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { ToneBadge } from "@/components/shared/status-badge";
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
import { ApiError } from "@/lib/api/client";
import { useActor, usePatchRequirement } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import { cn } from "@/lib/utils";
import type { RequirementDetail } from "@/types";

/**
 * Move a requirement's authored status (requirement-status-gates §4.5). Only
 * the free band is offered — the same moves `AUTHOR_TARGETS` allows on the
 * server, so nothing this menu offers can come back 409. The two earned bands
 * are listed disabled with the reason, because a person who cannot find
 * `Tested` must learn where it comes from rather than conclude the list broke.
 *
 * A status move is not a content edit: it mints its own journal entry and
 * needs no second reviewer, so it lives here and not in the edit dialog.
 */

interface Move {
  readonly target: string;
  readonly label: string;
}

const MOVES: Record<string, readonly Move[]> = {
  NEW: [
    { target: "Ready for Review", label: "Send for review" },
    { target: "Rejected", label: "Reject" },
  ],
  Draft: [
    { target: "Ready for Review", label: "Send for review" },
    { target: "Rejected", label: "Reject" },
  ],
  "Ready for Review": [
    { target: "Draft", label: "Withdraw to Draft" },
    { target: "Rejected", label: "Reject" },
  ],
  "In Review": [
    { target: "Draft", label: "Withdraw to Draft" },
    { target: "Rejected", label: "Reject" },
  ],
  Reviewed: [
    { target: "Draft", label: "Reopen as Draft" },
    { target: "Ready for Review", label: "Send for review" },
    { target: "Rejected", label: "Reject" },
  ],
  Rejected: [
    { target: "Draft", label: "Reopen as Draft" },
    { target: "Ready for Review", label: "Send for review" },
  ],
  Obsolete: [],
};

/* A status the map does not name still reaches the free band, the way the
   server's table does: the planning mirror stores an empty status when a push
   omits the field, and such a row must still be movable. */
const UNKNOWN_MOVES: readonly Move[] = [
  { target: "Draft", label: "Move to Draft" },
  { target: "Ready for Review", label: "Send for review" },
  { target: "Rejected", label: "Reject" },
];

interface EarnedStatus {
  readonly status: string;
  readonly reason: string;
}

const REVIEW_BAND: readonly EarnedStatus[] = [
  {
    status: "In Review",
    reason:
      "Earned when a reviewer claims this requirement on the Review page. That page is not built yet, so nothing can claim it today.",
  },
  {
    status: "Reviewed",
    reason:
      "Earned when a second person accepts the review on the Review page. That page is not built yet, so this status cannot be reached today.",
  },
];

const DERIVED_BAND: readonly EarnedStatus[] = [
  {
    status: "Implemented",
    reason: "Earned when a test run exercises a covering test case.",
  },
  {
    status: "Tested",
    reason: "Earned when every covering test case passes. Shown in Verification.",
  },
];

const FAILURES: Record<string, string> = {
  stale_parent: "This requirement changed since the page loaded. Reload and move it again.",
  no_op_mint: "The requirement already has that status.",
  requirement_not_found: "The registry holds no requirement under this id any more.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    // The server knows both ends of the move, so its own sentence names the
    // band that owns the target (requirement-status-gates §4.2).
    if (error.code === "illegal_transition") return error.detail;
    return FAILURES[error.code] ?? `The registry refused the move: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The move never reached the registry. Check the connection and try again.";
}

/** The line under the Status cell: what the current state is waiting on. */
export function statusHint(status: string): string | null {
  if (status === "Ready for Review") {
    return "Waiting for a reviewer to claim it. Claiming and accepting happen on the Review page, which is not built yet.";
  }
  if (status === "In Review") {
    return "Claimed for review. Accepting it, rejecting it or asking for changes happens on the Review page, which is not built yet.";
  }
  if (status === "Obsolete") {
    return "Retired. A retired requirement never returns and its id is never reused.";
  }
  return null;
}

function EarnedRows({ rows }: { rows: readonly EarnedStatus[] }) {
  return (
    <>
      {rows.map((row) => (
        <DropdownMenuItem key={row.status} disabled className="flex-col items-start gap-0">
          <span className="font-semibold">{row.status}</span>
          <span className="text-[0.7rem] whitespace-normal">{row.reason}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}

export function StatusControl({ detail }: { detail: RequirementDetail }) {
  const actor = useActor();
  const patchRequirement = usePatchRequirement(detail.req_id, actor);
  const moves = MOVES[detail.status] ?? UNKNOWN_MOVES;

  const move = (target: string) => {
    patchRequirement.mutate(
      { status: target, parent_version: detail.item_version },
      {
        onSuccess: () => toast(`${detail.req_id} is ${target}`),
        onError: (error: unknown) => toast(messageFor(error)),
      },
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(buttonVariants({ variant: "outline", size: "sm" }), "font-semibold")}
        disabled={actor === null || patchRequirement.isPending}
        aria-label={`Status: ${detail.status}`}
        title={actor === null ? NO_ACTOR_MESSAGE : "Move this requirement to another status"}
      >
        <ToneBadge tone="neutral">{detail.status.length > 0 ? detail.status : "No status"}</ToneBadge>
        <ChevronDown />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[340px]">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Status — what people decide</DropdownMenuLabel>
          {moves.length === 0 ? (
            <p className="px-1.5 py-1 text-[0.72rem] whitespace-normal">
              Retired. A retired requirement never returns and its id is never reused.
            </p>
          ) : (
            moves.map((entry) => (
              <DropdownMenuItem key={entry.target} onClick={() => move(entry.target)}>
                {entry.label}
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Earned on the Review page</DropdownMenuLabel>
          <EarnedRows rows={REVIEW_BAND} />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Earned by the runs</DropdownMenuLabel>
          <EarnedRows rows={DERIVED_BAND} />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <p className="px-1.5 py-1 text-[0.72rem] whitespace-normal">
          Status is what people decide. Verification is what the runs prove.
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

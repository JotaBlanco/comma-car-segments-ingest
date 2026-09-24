"use client";

import { useState } from "react";
import { toast } from "sonner";
import { SingleSelect } from "@/components/shared/single-select";
import { ApiError } from "@/lib/api/client";
import { useSetWorkOrderStatus } from "@/lib/hooks";
import type { WorkOrderStatus } from "@/types";

/**
 * The status of one work order, as a person sets it.
 *
 * Planning owns the content of a work order; the status is the one field a
 * person decides here, so this is the only editable control on the screen.
 * `PATCH /work-orders/{wo_id}` stores it with the source `manual` and
 * journals the move under the viewer's Portal name.
 */

const OPTIONS = [
  { value: "active", label: "Active" },
  { value: "closed", label: "Closed — campaign inactive" },
] as const;

const FAILURES: Record<string, string> = {
  wo_not_found: "The registry holds no work order under this id any more.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the status: ${error.detail}`;
  }
  return "The status never reached the registry. Check the connection and try again.";
}

interface WorkOrderStatusControlProps {
  readonly woId: string;
  readonly status: WorkOrderStatus;
}

export function WorkOrderStatusControl({ woId, status }: WorkOrderStatusControlProps) {
  const [failure, setFailure] = useState<string | null>(null);
  const setStatus = useSetWorkOrderStatus(woId);

  const pick = (next: string) => {
    if (next === status) return;
    setFailure(null);
    setStatus.mutate(next as WorkOrderStatus, {
      onSuccess: (workOrder) =>
        toast(
          workOrder.status === "closed"
            ? `${woId} closed — the campaign reads inactive.`
            : `${woId} reopened — the campaign reads active.`,
        ),
      onError: (error) => setFailure(messageFor(error)),
    });
  };

  return (
    <div className="grid gap-1">
      <SingleSelect
        label="Status"
        value={status}
        onChange={pick}
        options={OPTIONS}
        disabled={setStatus.isPending}
        triggerClassName="min-w-[190px]"
      />
      <p className="text-[0.7rem] text-ink-3">
        The status you set here is yours, stored under your name — until a planning sync states
        a status of its own.
      </p>
      {failure !== null && (
        <div
          role="alert"
          className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
        >
          {failure}
        </div>
      )}
    </div>
  );
}

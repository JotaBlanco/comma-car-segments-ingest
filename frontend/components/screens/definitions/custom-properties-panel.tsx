"use client";

import { Pencil } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  CustomPropertiesEditor,
  PROPERTY_FAILURES,
  mapOf,
  propertyProblem,
  rowsOf,
  sameMap,
  type PropertyRow,
} from "@/components/shared/custom-properties-editor";
import { EmptyState } from "@/components/shared/empty-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useSetDefinitionCustomProperties } from "@/lib/hooks";
import { cn } from "@/lib/utils";

/**
 * The Custom properties panel of the definition detail screen.
 *
 * The planning metadata card above stays read-only, because planning owns
 * every field on it. This card is the opposite: a person owns every pair here.
 * They sit in their own card, and never in the planning grid, so nobody reads
 * a typed fact as something planning sent.
 *
 * The pairs live in their own store beside the mirror, so a planning sync pass
 * never erases one. They therefore always carry the source `manual`.
 *
 * The editor, the caps and the refusal sentences come from the shared
 * component the run's edit dialog uses, so the two screens hold one rule.
 */
interface CustomPropertiesPanelProps {
  tdId: string;
  properties: Record<string, string>;
  className?: string;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return PROPERTY_FAILURES[error.code] ?? `The registry refused the edit: ${error.detail}`;
  }
  return "The edit never reached the registry. Check the connection and try again.";
}

export function CustomPropertiesPanel({
  tdId,
  properties,
  className,
}: CustomPropertiesPanelProps) {
  const [rows, setRows] = useState<PropertyRow[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const setProperties = useSetDefinitionCustomProperties(tdId);
  const pairs = Object.entries(properties);

  const stop = () => {
    setRows(null);
    setFailure(null);
  };

  const save = () => {
    if (rows === null) return;
    const problem = propertyProblem(rows);
    if (problem !== null) {
      setFailure(problem);
      return;
    }
    const next = mapOf(rows);
    if (sameMap(next, properties)) {
      setFailure("Nothing changed yet. Edit a pair, then save.");
      return;
    }
    setFailure(null);
    setProperties.mutate(
      { custom_properties: next },
      {
        onSuccess: () => {
          toast(`${tdId}: the custom properties now read manual — the journal records the change`);
          stop();
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Panel className={className}>
      <PanelHead
        title="Custom properties"
        action={
          <span className="inline-flex items-center gap-2 text-[0.7rem] text-ink-3">
            <SourceBadge source="manual" /> — a person owns these, never the planning system
            {rows === null && (
              <button
                type="button"
                onClick={() => {
                  setRows(rowsOf(properties));
                  setFailure(null);
                }}
                className={cn(
                  "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[11px] py-[5px] text-[0.74rem] font-semibold text-foreground transition-colors",
                  "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                )}
              >
                <Pencil className="size-[13px]" strokeWidth={2.4} />
                Edit properties
              </button>
            )}
          </span>
        }
      />

      {rows === null ? (
        pairs.length === 0 ? (
          <EmptyState message="This definition carries no custom property yet." />
        ) : (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-[0.78rem]">
            {pairs.map(([key, value]) => (
              <div key={key} className="col-span-2 grid grid-cols-subgrid">
                <dt className="text-ink-3">{key}</dt>
                <dd className="font-medium break-words">{value}</dd>
              </div>
            ))}
          </dl>
        )
      ) : (
        <div className="grid gap-2 px-4 py-3">
          <p className="text-[0.7rem] text-ink-3">
            Free name and value pairs. Remove a row to delete that property. A planning sync pass
            never touches them.
          </p>

          <CustomPropertiesEditor
            rows={rows}
            onRowsChange={(next) => {
              setRows(next);
              setFailure(null);
            }}
            emptyMessage="This definition carries no custom property."
          />

          {failure !== null && (
            <div
              role="alert"
              className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
            >
              {failure}
            </div>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={stop}>
              Cancel
            </Button>
            <Button size="sm" disabled={setProperties.isPending} onClick={save}>
              {setProperties.isPending ? "Saving…" : "Save properties"}
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}

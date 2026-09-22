import Link from "next/link";
import { Panel, PanelHead } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { ToneBadge, type BadgeTone } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatArrival } from "@/lib/format";
import type { RequirementDetail, VerdictOutcome } from "@/types";
import { MonoChip } from "./chip-list";

const OUTCOME: Record<VerdictOutcome, { tone: BadgeTone; label: string }> = {
  pass: { tone: "green", label: "Pass" },
  fail: { tone: "red", label: "Fail" },
  error: { tone: "amber", label: "Error" },
};

const COLS = 6;

/**
 * Panel E — one row per `(run, definition)`, so a run and its verdict never
 * split across two lists (spec §7E). `covering_run_count` counts distinct
 * runs; a run covering two of this requirement's definitions yields two
 * rows here.
 */
export function CoveringRunsPanel({ detail }: { detail: RequirementDetail }) {
  const evidence = detail.evidence;

  return (
    <Panel className="mb-3">
      <PanelHead
        title="Runs covering this requirement"
        action={
          <span className="font-mono text-[0.68rem] text-ink-3">
            {detail.covering_run_count} {detail.covering_run_count === 1 ? "run" : "runs"}
          </span>
        }
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Run</TableHead>
            <TableHead>Definition</TableHead>
            <TableHead>Arrived</TableHead>
            <TableHead>Verdict</TableHead>
            <TableHead>Evidence</TableHead>
            <TableHead>Current</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {evidence.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={COLS} className="p-0!">
                <span className="grid place-items-center px-4 py-7 text-[0.78rem] text-ink-3">
                  {detail.covering_run_count > 0
                    ? "These runs carry the covering test definitions. No verdict has been written for them yet."
                    : "No run has carried a covering test definition yet."}
                </span>
              </TableCell>
            </TableRow>
          )}
          {evidence.map((row, index) => (
            <RowLink
              key={`${row.run_id}-${row.definition_id}-${index}`}
              href={`/runs/${encodeURIComponent(row.run_id)}`}
            >
              <TableCell>
                <RowLinkLabel>
                  <span className="font-mono text-[0.78rem]">{row.run_id}</span>
                </RowLinkLabel>
              </TableCell>
              <TableCell>
                <Link
                  href={`/definitions/${encodeURIComponent(row.definition_id)}`}
                  className="font-mono text-[0.78rem] hover:underline"
                >
                  {row.definition_id}
                </Link>
              </TableCell>
              <TableCell>
                {row.first_data_at !== undefined ? formatArrival(row.first_data_at) : "—"}
              </TableCell>
              <TableCell>
                {row.outcome === null ? (
                  <span className="text-ink-3">—</span>
                ) : (
                  <ToneBadge tone={OUTCOME[row.outcome].tone} dot>
                    {OUTCOME[row.outcome].label}
                  </ToneBadge>
                )}
              </TableCell>
              <TableCell>
                <span className="inline-flex flex-wrap gap-1">
                  {Object.entries(row.evidence_values).map(([key, value]) => (
                    <MonoChip key={key}>{`${key}: ${value}`}</MonoChip>
                  ))}
                  {Object.keys(row.evidence_values).length === 0 && (
                    <span className="text-ink-3">—</span>
                  )}
                </span>
              </TableCell>
              <TableCell>
                {row.current ? (
                  <span aria-label="Current">✓</span>
                ) : (
                  <ToneBadge tone="amber">stale</ToneBadge>
                )}
              </TableCell>
            </RowLink>
          ))}
        </TableBody>
      </Table>
    </Panel>
  );
}

"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { ChipList, MonoChip } from "@/components/screens/requirements/chip-list";
import { RowLinkLabel } from "@/components/shared/row-link";
import type { SourceKind } from "@/components/shared/source-badge";
import { DefinitionStatusBadge, ToneBadge } from "@/components/shared/status-badge";
import type { TestDefinitionListItem } from "@/types";
import { DefinitionVerdictChip } from "./definition-verdict-chip";

/**
 * The one declaration of the test definitions grid's data columns.
 *
 * Header and body both map this list, so hiding a column is a filter over it
 * and cannot leave a header without its cells. The same shape the requirements
 * grid uses (`requirements-columns.tsx`), because the two tables are the same
 * table with different rows.
 */

export interface DefinitionColumn {
  /** Stored in `localStorage` when hidden — renaming one resets that person's choice. */
  readonly id: string;
  readonly label: string;
  readonly source: SourceKind;
  readonly align?: "right";
  /** A pinned column has no checkbox and always renders. */
  readonly pinned?: boolean;
  readonly cellClassName?: string;
  readonly cell: (row: TestDefinitionListItem) => ReactNode;
}

const NUMERIC_CELL = "text-right font-mono text-[0.78rem]";

export const DEFINITION_COLUMNS: readonly DefinitionColumn[] = [
  {
    id: "td_id",
    label: "Definition",
    source: "api:planning",
    pinned: true,
    cell: (row) => (
      <RowLinkLabel>
        <span className="font-mono text-[0.78rem]">{row.td_id}</span>
      </RowLinkLabel>
    ),
  },
  {
    id: "title",
    label: "Title",
    source: "api:planning",
    cellClassName: "whitespace-normal",
    cell: (row) => row.title,
  },
  {
    id: "work_order",
    label: "Work order",
    source: "api:planning",
    cell: (row) =>
      row.work_order_id === null ? (
        <span className="text-ink-3">—</span>
      ) : (
        <span className="font-mono text-[0.78rem]">{row.work_order_id}</span>
      ),
  },
  {
    id: "status",
    label: "Status",
    source: "derived",
    cell: (row) => <DefinitionStatusBadge status={row.status} />,
  },
  {
    id: "verdict",
    label: "Verdict",
    source: "derived",
    cell: (row) => <DefinitionVerdictChip state={row.verdict_state} />,
  },
  {
    id: "last_verdict_run",
    label: "Last run",
    source: "derived",
    cell: (row) =>
      row.latest_verdict ? (
        <Link
          href={`/runs/${encodeURIComponent(row.latest_verdict.run_id)}`}
          className="font-mono text-[0.78rem] hover:underline"
        >
          {row.latest_verdict.run_id}
        </Link>
      ) : (
        <span className="text-ink-3">—</span>
      ),
  },
  {
    id: "requirements",
    label: "Requirements",
    source: "api:planning",
    cell: (row) => (
      <ChipList
        items={row.covers_req_ids ?? []}
        renderItem={(reqId) => (
          <Link href={`/requirements/${encodeURIComponent(reqId)}`} className="hover:underline">
            <MonoChip>{reqId}</MonoChip>
          </Link>
        )}
      />
    ),
  },
  {
    id: "planned_runs",
    label: "Planned runs",
    source: "api:planning",
    align: "right",
    cellClassName: NUMERIC_CELL,
    cell: (row) => row.planned_runs,
  },
  {
    id: "actual_runs",
    label: "Actual runs",
    source: "derived",
    align: "right",
    cellClassName: NUMERIC_CELL,
    cell: (row) => row.actual_runs,
  },
  {
    id: "link",
    label: "Link",
    source: "derived",
    cell: (row) =>
      row.orphaned ? (
        <ToneBadge tone="amber" dot>
          Orphaned
        </ToneBadge>
      ) : (
        <ToneBadge tone="green" dot>
          Linked
        </ToneBadge>
      ),
  },
];

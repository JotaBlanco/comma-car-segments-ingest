"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { RowLinkLabel } from "@/components/shared/row-link";
import { ToneBadge } from "@/components/shared/status-badge";
import { ChipList, MonoChip } from "./chip-list";
import { VerificationChip } from "./verification-chip";
import type { RequirementRow } from "@/types";

/**
 * The one declaration of the requirements grid's data columns.
 *
 * Header and body both map this list, so hiding a column is a filter over it
 * and cannot leave a header without its cells. The select checkbox and the
 * row actions are not in it: they are chrome, they are never hidden, and the
 * screen renders them either side of nothing.
 */

export interface RequirementColumn {
  /** Stored in `localStorage` when hidden — renaming one resets that person's choice. */
  readonly id: string;
  readonly label: string;
  readonly align?: "right";
  /** A pinned column has no checkbox and always renders. */
  readonly pinned?: boolean;
  readonly cellClassName?: string;
  readonly cell: (row: RequirementRow) => ReactNode;
}

function ChipLink({ href, id }: { href: string; id: string }) {
  return (
    <Link href={href} className="hover:underline">
      <MonoChip>{id}</MonoChip>
    </Link>
  );
}

export const REQUIREMENT_COLUMNS: readonly RequirementColumn[] = [
  {
    id: "req_id",
    label: "Requirement",
    pinned: true,
    cell: (row) => (
      <RowLinkLabel>
        <span className="font-mono text-[0.78rem]">{row.req_id}</span>
      </RowLinkLabel>
    ),
  },
  {
    id: "title",
    label: "Title",
    cellClassName: "whitespace-normal",
    cell: (row) => row.title,
  },
  {
    id: "chapter",
    label: "Chapter",
    cell: (row) => row.chapter ?? "—",
  },
  {
    id: "status",
    label: "Status",
    cell: (row) => <ToneBadge tone="neutral">{row.status}</ToneBadge>,
  },
  {
    id: "verification",
    label: "Verification",
    cell: (row) => <VerificationChip state={row.verification_state} stale={row.evidence_stale} />,
  },
  {
    id: "verified_by",
    label: "Verified by",
    cell: (row) => (
      <ChipList
        items={row.verified_by}
        renderItem={(td) => <ChipLink href={`/definitions/${encodeURIComponent(td)}`} id={td} />}
        emptyLabel={<span className="text-ink-3">Not covered</span>}
      />
    ),
  },
  {
    id: "latest_run",
    label: "Latest run",
    cell: (row) =>
      row.latest_run_id === null ? (
        <span className="text-ink-3">—</span>
      ) : (
        <Link
          href={`/runs/${encodeURIComponent(row.latest_run_id)}`}
          className="font-mono text-[0.78rem] hover:underline"
        >
          {row.latest_run_id}
        </Link>
      ),
  },
  {
    id: "runs",
    label: "Runs",
    align: "right",
    cellClassName: "text-right font-mono text-[0.78rem]",
    cell: (row) => row.covering_run_count,
  },
  {
    id: "method",
    label: "Method",
    cell: (row) => row.verification_method ?? "—",
  },
  {
    id: "ears_pattern",
    label: "EARS pattern",
    cell: (row) => row.ears_pattern ?? "—",
  },
  {
    id: "system_states",
    label: "System states",
    cell: (row) => (
      <ChipList items={row.system_states ?? []} renderItem={(v) => <MonoChip>{v}</MonoChip>} />
    ),
  },
  {
    id: "measurands",
    label: "Measurands",
    cell: (row) => (
      <ChipList
        items={row.measurand ?? []}
        renderItem={(m) => <MonoChip>{`${m.name} (${m.unit})`}</MonoChip>}
      />
    ),
  },
  {
    id: "revision",
    label: "Revision",
    cellClassName: "font-mono text-[0.78rem]",
    cell: (row) => row.revision ?? "—",
  },
  {
    id: "source",
    label: "Source",
    cell: (row) => (
      <ChipList items={row.source ?? []} renderItem={(v) => <MonoChip>{v}</MonoChip>} />
    ),
  },
  {
    id: "related_reqs",
    label: "Related reqs",
    cell: (row) => (
      <ChipList
        items={row.related_reqs ?? []}
        renderItem={(id) => <ChipLink href={`/requirements/${encodeURIComponent(id)}`} id={id} />}
      />
    ),
  },
];

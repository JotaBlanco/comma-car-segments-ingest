"use client";

import { useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { LoadingRows } from "@/components/shared/loading-rows";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead, TableScrollArea } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { ToneBadge } from "@/components/shared/status-badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { TablePager } from "@/components/shared/table-pager";
import { useTestDefinitions } from "@/lib/hooks";
import type { TestDefinitionListFilters } from "@/types";

/**
 * Test definitions — minimal list (TR-001).
 *
 * The Home panel links here with `?orphaned=true`. The screen reads that one
 * param and passes it to the API. It offers no sort control and no other
 * filter.
 */

const DEFINITION_COLUMNS = 6;

export function DefinitionsScreen() {
  const searchParams = useSearchParams();
  const orphanedOnly = searchParams.get("orphaned") === "true";

  /* The list route pages like every other list, but the screen used to read
     `data.items` alone: page 2 of the mirror was unreachable, and the table
     silently showed the first 20 definitions as if they were all of them.
     Local state suffices — the screen owns no other URL param beyond
     `orphaned`, which stays where it is. */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  /* Flipping between "all" and "orphaned" changes the row set, so a page deep
     in one set means nothing in the other — back to page 1. State is adjusted
     during render (the pattern react.dev names for "reset state when a prop
     changes"), not in an effect: an effect would render the stale page once
     and fetch it. */
  const [prevOrphanedOnly, setPrevOrphanedOnly] = useState(orphanedOnly);
  if (prevOrphanedOnly !== orphanedOnly) {
    setPrevOrphanedOnly(orphanedOnly);
    setPage(1);
  }

  const filters: TestDefinitionListFilters = useMemo(
    () => ({
      ...(orphanedOnly ? { orphaned: true } : {}),
      page,
      page_size: pageSize,
    }),
    [orphanedOnly, page, pageSize],
  );

  const { data, isPending, isError, refetch } = useTestDefinitions(filters);
  const definitions = data?.items;
  const showEmpty = !isPending && !isError && definitions !== undefined && definitions.length === 0;

  return (
    <FullHeightPage>
      <PageHeader
        title="Test definitions"
        sub={
          <span className="inline-flex items-center gap-1.5 text-[0.7rem] text-ink-3">
            <SourceBadge source="api:planning" />
            Read-only mirror of the planning system — an orphan names no mirrored work order.
          </span>
        }
      />
      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead title={orphanedOnly ? "Orphaned definitions" : "Mirrored definitions"} />
        <TableScrollArea>
          <Table aria-label="Test definitions">
            <TableHeader>
              <TableRow>
                <TableHead>Definition</TableHead>
                <TableHead>Title</TableHead>
                <TableHead>Work order</TableHead>
                <TableHead className="text-right!">Planned runs</TableHead>
                <TableHead className="text-right!">Actual runs</TableHead>
                <TableHead>Link</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isPending && <LoadingRows rows={4} cols={DEFINITION_COLUMNS} />}
              {isError && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={DEFINITION_COLUMNS} className="p-0!">
                    <ErrorState onRetry={() => void refetch()} />
                  </TableCell>
                </TableRow>
              )}
              {showEmpty && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={DEFINITION_COLUMNS} className="p-0!">
                    <span className="grid place-items-center px-4 py-7 text-[0.78rem] text-ink-3">
                      {orphanedOnly ? "No orphaned test definitions." : "No test definitions mirrored yet."}
                    </span>
                  </TableCell>
                </TableRow>
              )}
              {definitions?.map((definition) => (
                <RowLink
                  key={definition.td_id}
                  href={`/definitions/${encodeURIComponent(definition.td_id)}`}
                >
                  <TableCell>
                    <RowLinkLabel>
                      <span className="font-mono text-[0.78rem]">{definition.td_id}</span>
                    </RowLinkLabel>
                  </TableCell>
                  <TableCell className="whitespace-normal">{definition.title}</TableCell>
                  <TableCell>
                    {definition.work_order_id === null ? (
                      <span className="text-ink-3">—</span>
                    ) : (
                      <span className="font-mono text-[0.78rem]">{definition.work_order_id}</span>
                    )}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[0.78rem]">
                    {definition.planned_runs}
                  </TableCell>
                  <TableCell className="text-right font-mono text-[0.78rem]">
                    {definition.actual_runs}
                  </TableCell>
                  <TableCell>
                    {definition.orphaned ? (
                      <ToneBadge tone="amber" dot>
                        Orphaned
                      </ToneBadge>
                    ) : (
                      <ToneBadge tone="green" dot>
                        Linked
                      </ToneBadge>
                    )}
                  </TableCell>
                </RowLink>
              ))}
            </TableBody>
          </Table>
        </TableScrollArea>
        {/* Wired the way the files screen wires its pager: the numbers come
            from the response envelope, never from the request state. */}
        {data !== undefined && (
          <TablePager
            page={data.page}
            pageSize={data.page_size}
            total={data.total}
            totalPages={data.total_pages}
            onPageChange={setPage}
            onPageSizeChange={(size) => {
              setPageSize(size);
              setPage(1);
            }}
          />
        )}
      </Panel>
    </FullHeightPage>
  );
}

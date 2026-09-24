"use client";

import { useCallback, useMemo, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { ErrorState } from "@/components/shared/error-state";
import { FullHeightPage } from "@/components/shared/full-height-page";
import { PageHeader } from "@/components/shared/page-header";
import { Panel, PanelHead } from "@/components/shared/panel";
import { useRequirements, useRuns, useTestDefinitions, useWorkOrders } from "@/lib/hooks";
import { buildTraceabilityTree, defaultOpenKeys } from "./traceability-model";
import { TreeRow, type Opening } from "./tree-row";

/**
 * The traceability tree: project, system, requirement, test definition, run.
 *
 * Four list reads, one each, and the nesting is joined here. The registry
 * holds tens of rows per list, so a tree route on the API would only move the
 * same join to the server and cost a call per level the way the lake's tree
 * does — the lake reads one level at a time because its estate is unbounded,
 * and this one is not.
 */

/** Every row of every list, in one page each. */
const PAGE_SIZE = 200;

export function TraceabilityScreen() {
  const requirements = useRequirements({ page_size: PAGE_SIZE });
  const definitions = useTestDefinitions({ page_size: PAGE_SIZE });
  const runs = useRuns({ page_size: PAGE_SIZE }, { poll: false });
  const workOrders = useWorkOrders({ page_size: PAGE_SIZE });

  const nodes = useMemo(
    () =>
      buildTraceabilityTree({
        requirements: requirements.data?.items ?? [],
        definitions: definitions.data?.items ?? [],
        runs: runs.data?.items ?? [],
        workOrders: workOrders.data?.items ?? [],
      }),
    [requirements.data, definitions.data, runs.data, workOrders.data],
  );

  /* Null means nobody has touched the tree yet, so the default spine stands.
     The first toggle copies it and the choice is this person's from then on. */
  const defaults = useMemo(() => defaultOpenKeys(nodes), [nodes]);
  const [touched, setTouched] = useState<ReadonlySet<string> | null>(null);
  const openKeys = touched ?? defaults;

  const opening: Opening = useMemo(
    () => ({
      isOpen: (key: string) => openKeys.has(key),
      toggle: (key: string) =>
        setTouched((previous) => {
          const next = new Set(previous ?? defaults);
          if (!next.delete(key)) next.add(key);
          return next;
        }),
    }),
    [openKeys, defaults],
  );

  const reads = [requirements, definitions, runs, workOrders];
  const pending = reads.some((read) => read.isPending);
  const failed = reads.some((read) => read.isError);
  const retry = useCallback(() => {
    void requirements.refetch();
    void definitions.refetch();
    void runs.refetch();
    void workOrders.refetch();
  }, [requirements, definitions, runs, workOrders]);

  const counts = [
    `${requirements.data?.total ?? 0} requirements`,
    `${definitions.data?.total ?? 0} test definitions`,
    `${runs.data?.total ?? 0} test runs`,
  ].join(" · ");

  return (
    <FullHeightPage>
      <PageHeader
        title="Traceability"
        sub="The chain from a project down to the run that produced the evidence."
      />
      <Panel className="flex min-h-0 flex-1 flex-col">
        <PanelHead
          title="Project → system → requirement → test definition → test run"
          action={<span className="text-[0.72rem] text-ink-3">{counts}</span>}
        />
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {failed ? (
            <ErrorState
              message="Could not read the lists this tree is built from."
              onRetry={retry}
            />
          ) : pending ? (
            <p className="px-2 py-3 text-[0.78rem] text-ink-3">Loading…</p>
          ) : nodes.length === 0 ? (
            <EmptyState
              title="Nothing to trace yet"
              message="No requirement, test definition or test run is mirrored here."
            />
          ) : (
            <ul>
              {nodes.map((node) => (
                <TreeRow key={node.key} node={node} opening={opening} />
              ))}
            </ul>
          )}
        </div>
      </Panel>
    </FullHeightPage>
  );
}

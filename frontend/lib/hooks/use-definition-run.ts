"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/api/client";
import { getDefinitionRun, type DefinitionRunResult } from "@/lib/api/definition-runs";
import {
  pollDefinitionRun,
  runDefinition,
  runErrorMessage,
  runningText,
  viewOfOutcome,
  viewOfStored,
  type RunOutcome,
  type RunView,
  type RunWatch,
} from "@/lib/definition-run";
import { keys } from "./keys";

/** The pair's Job or stored verdict; null when the API holds neither yet. */
async function readStored(runId: string, tdId: string): Promise<DefinitionRunResult | null> {
  try {
    return await getDefinitionRun(runId, tdId);
  } catch (caught: unknown) {
    if (caught instanceof ApiError && caught.status === 404) return null;
    throw caught;
  }
}

function storedView(
  data: DefinitionRunResult | null | undefined,
  error: unknown,
): RunView {
  // No Portal login is not news on mount; the Run control says so when pressed.
  if (error instanceof ApiError && error.code === "quixlab_needs_login") return { kind: "idle" };
  if (error !== null) return { kind: "failed", text: runErrorMessage(error) };
  return viewOfStored(data ?? null);
}

export interface DefinitionRunControl {
  view: RunView;
  pending: boolean;
  run(): void;
}

/**
 * One definition's run on one test run: the stored verdict read once on mount, and a
 * `run()` that starts the Job and polls it. A Job found still running is polled too.
 */
export function useDefinitionRun(
  runId: string,
  tdId: string,
  enabled: boolean,
): DefinitionRunControl {
  const queryClient = useQueryClient();
  const stored = useQuery({
    queryKey: keys.runs.definitionRun(runId, tdId),
    queryFn: () => readStored(runId, tdId),
    enabled: enabled && runId.length > 0 && tdId.length > 0,
    retry: false,
  });
  const [live, setLive] = useState<RunView | null>(null);
  const mounted = useRef(true);
  const polling = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const follow = useCallback(
    (wait: (watch: RunWatch) => Promise<RunOutcome>) => {
      polling.current = true;
      const show = (view: RunView) => {
        if (mounted.current) setLive(view);
      };
      void (async () => {
        try {
          const outcome = await wait({
            onStatus: (status) => show({ kind: "pending", text: runningText(status) }),
            alive: () => mounted.current,
          });
          show(viewOfOutcome(outcome));
          if (outcome.kind === "finished") {
            queryClient.setQueryData(keys.runs.definitionRun(runId, tdId), outcome.result);
          }
          if (outcome.kind === "finished" && outcome.result.verdict !== null) {
            // The verdict is a new processed result, and it moves requirement status.
            void queryClient.invalidateQueries({ queryKey: keys.results.all });
            void queryClient.invalidateQueries({ queryKey: keys.requirements.all });
            void queryClient.invalidateQueries({ queryKey: keys.runs.detail(runId) });
          }
        } catch (caught: unknown) {
          show({ kind: "failed", text: runErrorMessage(caught) });
        } finally {
          polling.current = false;
        }
      })();
    },
    [queryClient, runId, tdId],
  );

  const run = useCallback(() => {
    if (polling.current) return;
    setLive({ kind: "pending", text: "Starting…" });
    follow((watch) => runDefinition(runId, tdId, watch));
  }, [follow, runId, tdId]);

  const found = stored.data;
  useEffect(() => {
    if (found?.state !== "running" || live !== null || polling.current) return;
    const status = found.status;
    follow((watch) => pollDefinitionRun(runId, tdId, status, watch));
  }, [found, live, follow, runId, tdId]);

  const view = live ?? storedView(stored.data, stored.error);
  return { view, pending: view.kind === "pending", run };
}

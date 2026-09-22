"use client";

import { useEffect, useState } from "react";
import { Upload } from "lucide-react";
import { Panel, PanelHead } from "@/components/shared/panel";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
} from "@/components/ui/combobox";
import { UploadResultDialog } from "@/components/screens/run-detail/upload-result-dialog";
import { useRuns } from "@/lib/hooks";
import type { TestRunListItem } from "@/types";

/** One page of picker matches. 200 is the largest allowed page. */
const RUN_PAGE_SIZE = 200;

/** Keystroke-to-request debounce for the picker's `?q=` search. */
const RUN_SEARCH_DEBOUNCE_MS = 250;

/** The typed picker text, trailing-edge debounced into a `?q=` value. */
function useDebouncedQuery(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

/**
 * Quick actions on Home (FR-DM-075) — upload a processed result from here.
 *
 * The dialog is the one the run detail Results tab already mounts, so both
 * screens send the same request and answer the same refusals. It needs a run,
 * and Home names none, so a person picks one first. The picker is the run
 * `Combobox` over `GET /test-runs?q=` that `link-run-dialog.tsx` uses: the
 * typed text becomes a debounced server-side search, so every registered run
 * is reachable and not only the first page.
 *
 * The dialog mounts on demand only. It reads the viewer's Portal profile, and
 * a dashboard nobody acted on must not ask the Portal who is looking.
 */
export function QuickActionsPanel() {
  const [runId, setRunId] = useState("");
  const [runQuery, setRunQuery] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);

  const debouncedQuery = useDebouncedQuery(runQuery.trim(), RUN_SEARCH_DEBOUNCE_MS);
  const runs = useRuns(
    debouncedQuery.length > 0
      ? { page_size: RUN_PAGE_SIZE, q: debouncedQuery }
      : { page_size: RUN_PAGE_SIZE },
    { poll: false },
  );
  const runItems = runs.data?.items ?? [];

  return (
    <Panel>
      <PanelHead title="Quick actions" />
      <div className="grid gap-2 p-4">
        <label htmlFor="quick-upload-run" className="text-[0.7rem] font-semibold text-ink-2">
          Run
        </label>
        <Combobox
          items={runItems}
          filter={null}
          itemToStringLabel={(run: TestRunListItem) => run.run_id}
          isItemEqualToValue={(a: TestRunListItem, b: TestRunListItem) => a.run_id === b.run_id}
          onInputValueChange={(text) => setRunQuery(text)}
          onValueChange={(run: TestRunListItem | null) => setRunId(run?.run_id ?? "")}
        >
          <ComboboxInput
            id="quick-upload-run"
            placeholder="Type to search every registered run"
            className="text-[0.8rem]"
          />
          <ComboboxContent>
            <ComboboxStatus>{runs.isFetching ? "Searching the registry…" : null}</ComboboxStatus>
            <ComboboxEmpty>
              {runs.isError
                ? "The run list never arrived. Reload the screen."
                : "No registered run matches."}
            </ComboboxEmpty>
            <ComboboxList>
              {(run: TestRunListItem) => (
                <ComboboxItem key={run.run_id} value={run}>
                  <span className="truncate text-[0.8rem]">
                    <span className="font-mono">{run.run_id}</span>
                    {run.description !== null && <> · {run.description}</>}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>

        <Button
          variant="outline"
          size="sm"
          className="mt-1 justify-self-start font-semibold text-ink"
          disabled={runId.length === 0}
          onClick={() => setUploadOpen(true)}
        >
          <Upload className="size-[13px]" strokeWidth={2.2} aria-hidden />
          Upload result
        </Button>
        <div className="text-[0.72rem] text-ink-3">
          {runId.length > 0
            ? "The registry stores the file against this run and records who made it."
            : "Pick a run first — a result belongs to one run."}
        </div>
      </div>

      {uploadOpen && runId.length > 0 && (
        <UploadResultDialog runId={runId} open={uploadOpen} onOpenChange={setUploadOpen} />
      )}
    </Panel>
  );
}

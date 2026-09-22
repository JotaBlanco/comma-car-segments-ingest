"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { ApiError } from "@/lib/api/client";
import { useActor, usePatchFile, useRuns } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { TestRunListItem } from "@/types";

/**
 * The quarantine repair (TR-003) — link one orphaned file to a run.
 *
 * A file quarantined for "no run key" names no run, and the registry cannot
 * read the bytes, so it cannot resolve the key by itself. A person states the
 * link here, through `PATCH /files/{file_id}`, and the file leaves quarantine
 * when the missing link was the reason it was refused.
 *
 * The run gets a picker over `GET /test-runs?q=`, never a bare text box: the
 * route checks the id and answers 422 `unknown_run` for the rest, and a person
 * cannot act on that refusal — the same reasoning the work-order picker in
 * `edit-run-dialog.tsx` follows. The typed text becomes a server-side `?q=`
 * (debounced), so every registered run is reachable, not only the first page.
 *
 * The caller mounts this dialog only while it is open (like the lifecycle
 * dialog), so the run list asks the registry nothing on a closed screen.
 */
interface LinkRunDialogProps {
  fileId: string;
  filename: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

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

/** One sentence a person can act on, per refusal `PATCH /files/{id}` answers. */
const FAILURES: Record<string, string> = {
  unknown_run:
    "The registry holds no run under that id any more. Reopen this dialog and pick again.",
  file_not_found: "The registry holds no file under this id any more. Reload the screen.",
  file_deleted: "The file is deleted. Restore it first, then link it.",
  file_archived: "The file is archived. Restore it first, then link it.",
  checksum_already_registered:
    "A registered file already holds these exact bytes, so the link would mint a second copy. The file keeps its quarantine.",
  no_fields_to_update: "Nothing changed, so the registry stored nothing. Pick a run first.",
  validation_error: "The registry refused a value. Check the fields and save again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the link: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  return "The link never reached the registry. Check the connection and try again.";
}

export function LinkRunDialog({ fileId, filename, open, onOpenChange }: LinkRunDialogProps) {
  const [runId, setRunId] = useState("");
  const [runQuery, setRunQuery] = useState("");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who made the link, so the write needs a
  // signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const patchFile = usePatchFile(fileId, actor);
  const debouncedQuery = useDebouncedQuery(runQuery.trim(), RUN_SEARCH_DEBOUNCE_MS);
  const runs = useRuns(
    debouncedQuery.length > 0
      ? { page_size: RUN_PAGE_SIZE, q: debouncedQuery }
      : { page_size: RUN_PAGE_SIZE },
  );
  const runItems = runs.data?.items ?? [];

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setRunId("");
      setNote("");
      setFailure(null);
    }
  };

  const submit = () => {
    if (actor === null) return;
    if (runId.length === 0) {
      setFailure("Pick a run first — the link needs one.");
      return;
    }
    setFailure(null);
    const trimmedNote = note.trim();
    patchFile.mutate(
      trimmedNote.length > 0 ? { run_id: runId, note: trimmedNote } : { run_id: runId },
      {
        onSuccess: (detail) => {
          // The route answers the patched file, so the toast states what
          // really happened: a repair for another reason keeps the quarantine.
          toast(
            detail.status === "quarantined"
              ? `${filename} is linked to ${runId} — it stays quarantined: ${detail.quarantine_reason ?? "another reason stands"}`
              : `${filename} is linked to ${runId} — the journal records the change`,
          );
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Link {filename} to a run
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            The link takes the source <b>manual</b>, and the journal records it under your name.
            A file quarantined for a missing run key leaves quarantine with this link. Nothing
            else about the file changes.
          </DialogDescription>
        </DialogHeader>

        {actor === null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            {NO_ACTOR_MESSAGE}
          </div>
        )}

        <div className="grid gap-1">
          <label htmlFor="link-run-id" className="text-[0.7rem] font-semibold text-ink-2">
            Run
          </label>
          <Combobox
            items={runItems}
            filter={null}
            itemToStringLabel={(run: TestRunListItem) => run.run_id}
            isItemEqualToValue={(a: TestRunListItem, b: TestRunListItem) => a.run_id === b.run_id}
            onInputValueChange={(text) => setRunQuery(text)}
            onValueChange={(run: TestRunListItem | null) => {
              setRunId(run?.run_id ?? "");
              setFailure(null);
            }}
          >
            <ComboboxInput
              id="link-run-id"
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
        </div>

        <div className="grid gap-1">
          <label htmlFor="link-run-note" className="text-[0.7rem] font-semibold text-ink-2">
            Note <span className="font-normal text-ink-3">(optional, joins the journal entry)</span>
          </label>
          <Textarea
            id="link-run-note"
            value={note}
            placeholder="e.g. Run key confirmed against the rig log"
            className="min-h-[60px] bg-surface-2 text-[0.8rem] focus-visible:bg-surface"
            onChange={(event) => setNote(event.target.value)}
          />
        </div>

        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
          >
            {failure}
          </div>
        )}

        <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
          Journalled as{" "}
          <span className="font-mono text-[0.74rem] text-ink-2">
            {actor ?? "nobody — sign in first"}
          </span>
          , with the source <span className="font-mono text-[0.74rem] text-ink-2">manual</span>.
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={actor === null || patchFile.isPending} onClick={submit}>
            {patchFile.isPending ? "Linking…" : "Link to run"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FileDropZone } from "@/components/shared/file-drop-zone";
import { ApiError } from "@/lib/api/client";
import { useRunFiles, useUploadResult } from "@/lib/hooks";
import { usePortalAuth, usePortalUser } from "@/lib/portal/use-portal-auth";

interface UploadResultDialogProps {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The display name `lib/portal/client.ts` returns when the profile carries no
 * name and no email. `api/api/provenance.py` refuses that string, so it names
 * nobody. The form treats it as "not signed in" and never sends it.
 */
const PLACEHOLDER_NAME = "quix user";

/**
 * One sentence a person can act on, per error the upload route answers.
 * See the result-upload box (v1.2) in `plans/API-CONTRACT.md`.
 */
const UPLOAD_ERRORS: Record<string, string> = {
  file_too_large:
    "The file passes the 100 MiB cap, so nothing was stored. Upload a summary artefact, not a raw measurement file.",
  storage_unreachable:
    "The result store did not answer, so nothing was stored. Wait a moment and upload again.",
  not_ready:
    "The audit journal refused the entry, so the upload stored no bytes. Wait a moment and upload again.",
  provenance_required:
    "The provenance is incomplete. State the tool, the version, the parameters and the maker, then upload again.",
  version_conflict:
    "Another write holds this result version right now. Wait a moment and upload again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return UPLOAD_ERRORS[error.code] ?? `The upload failed: ${error.detail}`;
  }
  return "The upload failed before it reached the registry. Check the connection and try again.";
}

/** A moment in the value shape a datetime-local input takes. */
function localInputValue(at: Date): string {
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/** The current local time, in the value shape a datetime-local input takes. */
function localNow(): string {
  return localInputValue(new Date());
}

/**
 * The file's own modification time. A tool wrote the file when it produced the
 * result, so that stamp answers "produced at" better than the clock does.
 * Answer null when the file carries no usable time, and the caller uses now.
 */
function fileTime(file: File): string | null {
  const stamp = file.lastModified;
  if (!Number.isFinite(stamp) || stamp <= 0) return null;
  return localInputValue(new Date(stamp));
}

/**
 * Keep what the person typed, and refresh only a value an earlier file pick
 * wrote. `lastFill` is the value the last pick put in the field, so a field
 * that still holds it carries no edit.
 */
function refresh(current: string, lastFill: string, next: string): string {
  return current.trim().length === 0 || current === lastFill ? next : current;
}

/** Drop the extension, so `thermal_summary_v1.parquet` suggests a result key. */
function keyFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, "");
}

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";

export function UploadResultDialog({ runId, open, onOpenChange }: UploadResultDialogProps) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState("");
  const [resultKey, setResultKey] = useState("");
  const [description, setDescription] = useState("");
  const [tool, setTool] = useState("");
  const [toolVersion, setToolVersion] = useState("");
  const [parameters, setParameters] = useState("");
  const [inputFileIds, setInputFileIds] = useState<string[]>([]);
  const [producedAt, setProducedAt] = useState(localNow);
  const [failure, setFailure] = useState<string | null>(null);
  // What the last file pick filled in. The dialog opens with the clock in
  // `producedAt`, so the first pick must be free to replace that default too.
  const filled = useRef({ name: "", resultKey: "", producedAt });

  const filesQuery = useRunFiles(runId);
  const upload = useUploadResult(runId);

  // The maker comes from the signed-in Quix Portal identity, never from a
  // typed string. No identity, no upload: a provenance record that signs
  // somebody else's name is worse than a result nobody uploaded.
  const { token } = usePortalAuth();
  const portalUser = usePortalUser(token);
  const displayName = portalUser.data?.displayName.trim() ?? "";
  const producedBy =
    displayName.length > 0 && displayName.toLowerCase() !== PLACEHOLDER_NAME ? displayName : null;

  const runFiles = filesQuery.data?.items ?? [];
  const complete =
    file !== null &&
    name.trim().length > 0 &&
    resultKey.trim().length > 0 &&
    tool.trim().length > 0 &&
    toolVersion.trim().length > 0 &&
    parameters.trim().length > 0 &&
    producedAt.length > 0;

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) setFailure(null);
  };

  const pickFile = (picked: File | null) => {
    setFile(picked);
    setFailure(null);
    if (picked === null) return;
    const next = {
      name: picked.name,
      resultKey: keyFromFilename(picked.name),
      producedAt: fileTime(picked) ?? localNow(),
    };
    const last = filled.current;
    filled.current = next;
    setName(refresh(name, last.name, next.name));
    setResultKey(refresh(resultKey, last.resultKey, next.resultKey));
    setProducedAt(refresh(producedAt, last.producedAt, next.producedAt));
  };

  const toggleInput = (fileId: string) => {
    setInputFileIds((current) =>
      current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId]
    );
  };

  const submit = () => {
    if (file === null || producedBy === null || !complete) return;
    setFailure(null);
    upload.mutate(
      {
        file,
        metadata: {
          run_id: runId,
          name: name.trim(),
          result_key: resultKey.trim(),
          description: description.trim().length > 0 ? description.trim() : null,
          provenance: {
            tool: tool.trim(),
            tool_version: toolVersion.trim(),
            parameters: parameters.trim(),
            input_file_ids: inputFileIds,
            produced_by: producedBy,
            produced_at: new Date(producedAt).toISOString(),
          },
        },
      },
      {
        onSuccess: (answer) => {
          toast(`${answer.body.name} uploaded — version ${answer.body.version}, journalled as manual`);
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Upload a processed result to {runId}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            The registry stores the file and records who made it, with which tool and from which
            inputs. The lineage is mandatory, so the form asks for all of it.
          </DialogDescription>
        </DialogHeader>

        {producedBy === null && (
          <div
            role="alert"
            className="rounded-md border border-amber-border bg-amber-bg px-3 py-2 text-[0.76rem] text-ink-2"
          >
            The upload needs a signed-in Quix identity, because the provenance names the maker. Sign
            in to the Quix Portal, then upload.
          </div>
        )}

        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="result-file" className={fieldClass}>
              Result file
            </label>
            <FileDropZone onFile={pickFile}>
              <Input
                id="result-file"
                type="file"
                className="h-auto py-1.5 text-[0.8rem]"
                onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              />
            </FileDropZone>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <label htmlFor="result-name" className={fieldClass}>
                Name
              </label>
              <Input
                id="result-name"
                value={name}
                placeholder="thermal_summary_v1.parquet"
                className="text-[0.8rem]"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor="result-key" className={fieldClass}>
                Result key
              </label>
              <Input
                id="result-key"
                value={resultKey}
                placeholder="thermal_summary"
                className="text-[0.8rem]"
                onChange={(event) => setResultKey(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1">
            <label htmlFor="result-description" className={fieldClass}>
              Description <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <Input
              id="result-description"
              value={description}
              placeholder="Cycle-level aggregates"
              className="text-[0.8rem]"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <label htmlFor="result-tool" className={fieldClass}>
                Tool
              </label>
              <Input
                id="result-tool"
                value={tool}
                placeholder="bat-post"
                className="text-[0.8rem]"
                onChange={(event) => setTool(event.target.value)}
              />
            </div>
            <div className="grid gap-1">
              <label htmlFor="result-tool-version" className={fieldClass}>
                Tool version
              </label>
              <Input
                id="result-tool-version"
                value={toolVersion}
                placeholder="2.3.1"
                className="text-[0.8rem]"
                onChange={(event) => setToolVersion(event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-1">
            <label htmlFor="result-parameters" className={fieldClass}>
              Parameters
            </label>
            <Input
              id="result-parameters"
              value={parameters}
              placeholder="--cycles all --dt 0.1"
              className="font-mono text-[0.78rem]"
              onChange={(event) => setParameters(event.target.value)}
            />
          </div>

          <div className="grid gap-1">
            <label htmlFor="result-produced-at" className={fieldClass}>
              Produced at
            </label>
            <Input
              id="result-produced-at"
              type="datetime-local"
              value={producedAt}
              className="text-[0.8rem]"
              onChange={(event) => setProducedAt(event.target.value)}
            />
          </div>

          <fieldset className="grid gap-1">
            <legend className={fieldClass}>Input files</legend>
            <div className="max-h-32 overflow-y-auto rounded-md border border-line p-1">
              {runFiles.length === 0 && (
                <div className="px-2 py-1.5 text-[0.74rem] text-ink-3">
                  This run registers no file yet.
                </div>
              )}
              {runFiles.map((runFile) => (
                <label
                  key={runFile.file_id}
                  className="group/field flex cursor-pointer items-center gap-2.5 rounded-sm px-2 py-1.5 text-[0.76rem] hover:bg-surface-2"
                >
                  <Checkbox
                    checked={inputFileIds.includes(runFile.file_id)}
                    onCheckedChange={() => toggleInput(runFile.file_id)}
                    aria-label={runFile.filename}
                  />
                  <span className="flex-1 font-mono text-[0.74rem]">{runFile.filename}</span>
                </label>
              ))}
            </div>
            {inputFileIds.length === 0 && (
              <div className="text-[0.7rem] text-ink-3">
                A result that names no input carries no traceability link, so the registry flags its
                provenance.
              </div>
            )}
          </fieldset>

          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
            Produced by{" "}
            <span className="font-mono text-[0.74rem] text-ink-2">
              {producedBy ?? "nobody — sign in first"}
            </span>
            . The name comes from your Quix Portal profile, and the registry journals the upload as
            manual.
          </div>
        </div>

        {failure !== null && (
          <div
            role="alert"
            className="rounded-md border border-red-border bg-red-bg px-3 py-2 text-[0.76rem] text-red"
          >
            {failure}
          </div>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!complete || producedBy === null || upload.isPending}
            onClick={submit}
          >
            {upload.isPending ? "Uploading…" : "Upload result"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

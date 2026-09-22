"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { FileDropZone } from "@/components/shared/file-drop-zone";
import { ApiError } from "@/lib/api/client";
import { formatBytes } from "@/lib/format";
import { useActor, useRegisterFileVersion } from "@/lib/hooks";
import { NO_ACTOR_MESSAGE } from "@/lib/hooks/use-actor";
import type { FileDetail } from "@/types";

interface UploadVersionDialogProps {
  file: FileDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One sentence a person can act on, per refusal the version route answers. */
const FAILURES: Record<string, string> = {
  file_not_found: "The registry holds no file under this id any more. Reload the screen.",
  file_deleted: "The file is deleted. Restore it first, then add a version.",
  file_archived: "The file is archived. Restore it first, then add a version.",
  checksum_already_registered:
    "A registered file already holds this checksum, so these bytes are already in the registry. Pick the changed file.",
  version_conflict:
    "Another upload holds the next version number right now. Wait a moment and try again.",
};

function messageFor(error: unknown): string {
  if (error instanceof ApiError) {
    return FAILURES[error.code] ?? `The registry refused the version: ${error.detail}`;
  }
  if (error instanceof Error && error.message === NO_ACTOR_MESSAGE) return NO_ACTOR_MESSAGE;
  if (error instanceof Error) return error.message;
  return "The version never reached the registry. Check the connection and try again.";
}

/**
 * The SHA-256 of the picked file, in lower-case hex.
 *
 * The browser reads the bytes and hashes them, so the checksum the registry
 * stores describes the file the person picked and nothing else. A typed
 * checksum would let a wrong value in.
 */
async function sha256Hex(picked: File): Promise<string> {
  const buffer = await picked.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The format of a filename — the extension, without the dot. */
function formatOf(filename: string, fallback: string): string {
  const match = /\.([^.]+)$/.exec(filename);
  return match ? match[1].toUpperCase() : fallback;
}

const fieldClass = "text-[0.7rem] font-semibold text-ink-2";

/** The state of the local hash, so the form can wait for it. */
interface PickedFile {
  name: string;
  sizeBytes: number;
  checksum: string;
}

/**
 * Register a new version of one file (FR-DM-103).
 *
 * `POST /files/{id}/versions` registers a whole new file document: a new id, a
 * new checksum and a new download. It writes nothing on the earlier versions,
 * so the previous version stays exactly as it is.
 */
export function UploadVersionDialog({ file, open, onOpenChange }: UploadVersionDialogProps) {
  const [picked, setPicked] = useState<PickedFile | null>(null);
  const [hashing, setHashing] = useState(false);
  const [storageRef, setStorageRef] = useState("");
  const [note, setNote] = useState("");
  const [failure, setFailure] = useState<string | null>(null);

  // The journal names the person who uploaded the version, so the write needs
  // a signed-in Quix Portal identity and never a typed default.
  const actor = useActor();
  const register = useRegisterFileVersion(file.file_id, actor);

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setPicked(null);
      setHashing(false);
      setStorageRef("");
      setNote("");
      setFailure(null);
    }
  };

  const pickFile = (next: File | null) => {
    setFailure(null);
    setPicked(null);
    if (next === null) return;
    setHashing(true);
    void sha256Hex(next)
      .then((checksum) => {
        setPicked({ name: next.name, sizeBytes: next.size, checksum });
      })
      .catch((error: unknown) => {
        setFailure(
          error instanceof Error
            ? `The browser could not read the file: ${error.message}`
            : "The browser could not read the file.",
        );
      })
      .finally(() => setHashing(false));
  };

  const submit = () => {
    if (picked === null || actor === null) return;
    setFailure(null);
    const trimmedRef = storageRef.trim();
    const trimmedNote = note.trim();
    register.mutate(
      {
        filename: picked.name,
        source_system: file.source_system,
        format: formatOf(picked.name, file.format),
        size_bytes: picked.sizeBytes,
        checksum_sha256: picked.checksum,
        ...(trimmedRef.length > 0 ? { storage_ref: trimmedRef } : {}),
        ...(trimmedNote.length > 0 ? { note: trimmedNote } : {}),
      },
      {
        onSuccess: (version) => {
          toast(
            `Version ${version.version ?? 1} registered as ${version.file_id} — every earlier version stays`,
          );
          close(false);
        },
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[88vh] overflow-y-auto rounded-[10px] p-5 sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            Add a version of {file.filename}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            The registry stores the version as a whole new file, with its own id, its own checksum
            and its own download. It changes no earlier version, so version {file.version ?? 1}{" "}
            stays exactly as it is. The version keeps the run of this file.
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

        <div className="grid gap-3">
          <div className="grid gap-1">
            <label htmlFor="version-file" className={fieldClass}>
              New version of the file
            </label>
            <FileDropZone onFile={pickFile}>
              <Input
                id="version-file"
                type="file"
                className="h-auto py-1.5 text-[0.8rem]"
                onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
              />
            </FileDropZone>
            <div className="text-[0.7rem] text-ink-3">
              The browser reads the bytes and computes the SHA-256, so the registry stores the
              checksum of this exact file.
            </div>
          </div>

          {hashing && (
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
              Reading the file and computing the checksum…
            </div>
          )}

          {picked !== null && (
            <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
              <div>
                <span className="font-semibold text-ink-2">{picked.name}</span> ·{" "}
                {formatBytes(picked.sizeBytes)}
              </div>
              <div className="mt-px font-mono text-[0.66rem] break-all">
                sha256:{picked.checksum}
              </div>
            </div>
          )}

          <div className="grid gap-1">
            <label htmlFor="version-storage-ref" className={fieldClass}>
              Storage reference <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <Input
              id="version-storage-ref"
              value={storageRef}
              placeholder="tas-raw/2026/08/bat_cyc_20260814_0941_v2.mf4"
              className="font-mono text-[0.76rem]"
              onChange={(event) => setStorageRef(event.target.value)}
            />
            <div className="text-[0.7rem] text-ink-3">
              Name where the pipeline stored these bytes. A version without a storage reference
              registers its metadata, and its download stays closed until the pipeline reports the
              location.
            </div>
          </div>

          <div className="grid gap-1">
            <label htmlFor="version-note" className={fieldClass}>
              Note <span className="font-normal text-ink-3">(optional)</span>
            </label>
            <Textarea
              id="version-note"
              value={note}
              placeholder="e.g. Re-converted after the channel map fix"
              className="min-h-[64px] bg-surface-2 text-[0.82rem] focus-visible:bg-surface"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>

          <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[0.74rem] text-ink-3">
            Journalled as{" "}
            <span className="font-mono text-[0.74rem] text-ink-2">
              {actor ?? "nobody — sign in first"}
            </span>
            , with the source <span className="font-mono text-[0.74rem] text-ink-2">manual</span>.
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
            disabled={picked === null || hashing || actor === null || register.isPending}
            onClick={submit}
          >
            {register.isPending ? "Registering…" : "Register version"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

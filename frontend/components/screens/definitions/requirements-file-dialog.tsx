"use client";

import { useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { FileDropZone } from "@/components/shared/file-drop-zone";
import { ApiError } from "@/lib/api/client";
import {
  useAddRequirementsFile,
  useEditRequirementsFile,
  useUploadRequirementsFileBytes,
} from "@/lib/hooks";
import type { RequirementsFile } from "@/types";

/**
 * The write dialog of the Requirements panel. It has two modes.
 *
 * **Add** (no `file`) writes one of two routes, and the picked file decides
 * which:
 *
 * - No file: it posts the name and the text to
 *   `POST /test-definitions/{td_id}/requirements-files`.
 * - A file: it posts the bytes to the multipart sibling `.../upload`. A PDF, a
 *   Word file, a spreadsheet or an image comes in this way.
 *
 * **Edit** (a `file`) patches the text of that one manual TEXT document
 * through `PATCH .../requirements-files/{name}`. **The name never changes**:
 * the name is the identity of the document, and the API has no rename. So the
 * edit mode shows no name box and no file box, and the API journals what the
 * edit changed.
 *
 * The API owns every rule — the name, the empty text, the two size caps — so
 * this dialog checks only that the boxes hold something, and it prints the
 * API's own sentence when the API refuses.
 */
interface RequirementsFileDialogProps {
  tdId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The document to edit. Absent puts the dialog in the add mode. */
  file?: RequirementsFile;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.detail;
  return "The document never reached the registry. Check the connection and try again.";
}

/** The API's own default: a `.md` name is markdown, every other name is not. */
function defaultRenderMarkdown(name: string): boolean {
  return name.trim().toLowerCase().endsWith(".md");
}

export function RequirementsFileDialog({
  tdId,
  open,
  onOpenChange,
  file: edited,
}: RequirementsFileDialogProps) {
  const editing = edited !== undefined;
  // Null means "follow the name". A tick or an untick pins the choice, so a
  // later edit of the name never undoes what the person just chose. The edit
  // mode starts from the stored flag, so the box shows what the reader saw.
  const storedMarkdown =
    edited === undefined ? null : (edited.render_markdown ?? defaultRenderMarkdown(edited.name));
  const [name, setName] = useState(edited?.name ?? "");
  const [content, setContent] = useState(edited?.content ?? "");
  const [file, setFile] = useState<File | null>(null);
  const [markdown, setMarkdown] = useState<boolean | null>(storedMarkdown);
  const [failure, setFailure] = useState<string | null>(null);
  const addFile = useAddRequirementsFile(tdId);
  const editFile = useEditRequirementsFile(tdId);
  const uploadBytes = useUploadRequirementsFileBytes(tdId);

  const pending = addFile.isPending || editFile.isPending || uploadBytes.isPending;
  const renderMarkdown = markdown ?? defaultRenderMarkdown(name);

  const close = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) {
      setName(edited?.name ?? "");
      setContent(edited?.content ?? "");
      setFile(null);
      setMarkdown(storedMarkdown);
      setFailure(null);
    }
  };

  const pickFile = (picked: File | null) => {
    setFile(picked);
    setFailure(null);
    // The filename is the best first guess at the document name, exactly as
    // the result upload prefills it.
    if (picked !== null && name.trim().length === 0) setName(picked.name);
  };

  const done = (message: string) => {
    toast(message);
    close(false);
  };

  const submit = () => {
    const trimmedName = name.trim();
    if (editing) {
      if (content.trim().length === 0) {
        setFailure("A document needs some text.");
        return;
      }
      setFailure(null);
      editFile.mutate(
        { name: edited.name, body: { content, render_markdown: renderMarkdown } },
        {
          onSuccess: () => done(`Saved ${edited.name} on ${tdId}`),
          onError: (error) => setFailure(messageFor(error)),
        },
      );
      return;
    }
    if (file !== null) {
      setFailure(null);
      uploadBytes.mutate(
        { file, name: trimmedName },
        {
          onSuccess: (answer) => done(`Added ${answer.body.name} to ${tdId}`),
          onError: (error) => setFailure(messageFor(error)),
        },
      );
      return;
    }
    if (trimmedName.length === 0) {
      setFailure("A document needs a name.");
      return;
    }
    if (content.trim().length === 0) {
      setFailure("A document needs some text, or a file.");
      return;
    }
    setFailure(null);
    addFile.mutate(
      { name: trimmedName, content, render_markdown: renderMarkdown },
      {
        onSuccess: () => done(`Added ${trimmedName} to ${tdId}`),
        onError: (error) => setFailure(messageFor(error)),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="rounded-[10px] p-5 sm:max-w-[560px]">
        <DialogHeader>
          <DialogTitle className="text-base font-bold tracking-[-0.01em]">
            {editing ? `Edit ${edited.name}` : `Add a requirements document to ${tdId}`}
          </DialogTitle>
          <DialogDescription className="text-[0.8rem] text-ink-2">
            {editing ? (
              <>
                The name stays as it is — it names the document everywhere. The registry records
                the change in the history of the definition, and it names you.
              </>
            ) : (
              <>
                The document holds plain text or markdown, or a file — a PDF, a Word file, a
                spreadsheet or an image. It carries the source <b>manual</b> and your name, and you
                can remove it again later.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          {/* The edit route never renames a document, so the edit mode offers
              neither the name box nor the file box. The title names the
              document a person is editing. */}
          {!editing && (
            <>
              <div>
                <label
                  htmlFor="requirements-file-name"
                  className="mb-1 block text-[0.74rem] font-semibold text-ink-2"
                >
                  Document name
                </label>
                <Input
                  id="requirements-file-name"
                  autoFocus
                  value={name}
                  aria-invalid={failure !== null || undefined}
                  placeholder="e.g. acceptance-criteria.md"
                  className="bg-surface-2 text-[0.82rem]"
                  onChange={(event) => setName(event.target.value)}
                />
              </div>

              <div>
                <label
                  htmlFor="requirements-file-bytes"
                  className="mb-1 block text-[0.74rem] font-semibold text-ink-2"
                >
                  File (optional)
                </label>
                <FileDropZone onFile={pickFile}>
                  <Input
                    id="requirements-file-bytes"
                    type="file"
                    className="h-auto bg-surface-2 py-1.5 text-[0.8rem]"
                    onChange={(event) => pickFile(event.target.files?.[0] ?? null)}
                  />
                </FileDropZone>
              </div>
            </>
          )}

          {/* A picked file replaces the text, so the two text controls go. A
              file holds bytes, and bytes carry no markdown. */}
          {file === null && (
            <>
              <div>
                <label
                  htmlFor="requirements-file-content"
                  className="mb-1 block text-[0.74rem] font-semibold text-ink-2"
                >
                  Document text
                </label>
                <Textarea
                  id="requirements-file-content"
                  autoFocus={editing}
                  value={content}
                  aria-invalid={failure !== null || undefined}
                  placeholder={"# Acceptance\n\n1. The pack reaches +40 °C within 45 min."}
                  className="min-h-[168px] bg-surface-2 font-mono text-[0.78rem] focus-visible:bg-surface"
                  onChange={(event) => setContent(event.target.value)}
                />
              </div>

              <label className="flex cursor-pointer items-center gap-2.5 text-[0.76rem] text-ink-2">
                <Checkbox
                  checked={renderMarkdown}
                  onCheckedChange={(next: boolean) => setMarkdown(next)}
                  aria-label="Render as markdown"
                />
                <span>
                  Render as markdown
                  <span className="ml-1 text-ink-3">
                    — a <span className="font-mono">.md</span> name turns this on by itself
                  </span>
                </span>
              </label>
            </>
          )}

          {failure !== null && (
            <div role="alert" className="text-[0.72rem] text-red">
              {failure}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" disabled={pending} onClick={submit}>
            {pending ? "Saving…" : editing ? "Save changes" : "Add document"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

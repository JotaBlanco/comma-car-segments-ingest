"use client";

import { Download, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/shared/empty-state";
import { MarkdownLite } from "@/components/shared/markdown-lite";
import { Panel, PanelHead } from "@/components/shared/panel";
import { SourceBadge } from "@/components/shared/source-badge";
import { Switch } from "@/components/ui/switch";
import { ApiError } from "@/lib/api/client";
import { triggerBrowserDownload } from "@/lib/api/download";
import { testDefinitionsApi } from "@/lib/api/testDefinitions";
import { formatArrival, formatBytes } from "@/lib/format";
import { useRemoveRequirementsFile } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import type { RequirementsFile } from "@/types";
import { RequirementsFileDialog } from "./requirements-file-dialog";

/**
 * The Requirements panel of the definition detail screen.
 *
 * A definition carries requirements documents. Planning owns a `planning`
 * document and a person owns a `manual` one. The API serves the list already
 * sorted — manual first, then by name — so this panel never sorts it.
 *
 * A manual TEXT document also carries an Edit control. It opens the same
 * dialog the Add control opens, in its edit mode. A planning document and a
 * binary document carry none: planning owns its own text, and bytes are
 * replaced by uploading the file again.
 *
 * A document holds text or bytes.
 *
 * - TEXT renders through `MarkdownLite` or as plain text, and the reader flips
 *   the switch. Both paths put every value through React as text, so raw HTML
 *   in a document stays visible characters and never becomes markup.
 * - BYTES render inline only when the browser renders them natively — an image
 *   through `<img>` and a PDF through `<object>`. Every other type gets a
 *   download button. The panel adds no viewer library.
 */
interface RequirementsPanelProps {
  tdId: string;
  files: RequirementsFile[];
  className?: string;
}

/**
 * The types the panel shows inline. The browser renders each one natively, so
 * no library is needed for any of them.
 *
 * The list stays an ALLOW-LIST. `content_type` is the label the browser stated
 * at upload, and a caller may state anything, so a value outside this list
 * shows a download button and never a viewer. `image/svg+xml` stays out: an
 * SVG carries markup, and the panel renders no markup it did not write.
 */
const INLINE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);
const INLINE_PDF_TYPE = "application/pdf";

function inlineKind(contentType: string | null | undefined): "image" | "pdf" | null {
  const type = (contentType ?? "").toLowerCase();
  if (INLINE_IMAGE_TYPES.has(type)) return "image";
  if (type === INLINE_PDF_TYPE) return "pdf";
  return null;
}

/** A document with a storage reference holds bytes, not text. */
function holdsBytes(file: RequirementsFile): boolean {
  return typeof file.storage_ref === "string" && file.storage_ref.length > 0;
}

/**
 * How a text document renders when the API states nothing.
 *
 * It is the API's own rule (`default_render_markdown`): a `.md` name renders
 * as markdown, and every other name renders as plain text. A row written
 * before the flag existed carries no value, and this keeps the two sides in
 * step without a migration.
 */
function rendersMarkdown(file: RequirementsFile): boolean {
  if (typeof file.render_markdown === "boolean") return file.render_markdown;
  return file.name.trim().toLowerCase().endsWith(".md");
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.detail;
  return "The registry never answered. Check the connection and try again.";
}

/**
 * The body of one TEXT document, with the markdown switch.
 *
 * The switch is the reader's own choice, and the panel never stores it: the
 * component is keyed on the document name, so picking another document falls
 * back to that document's own flag.
 */
function TextDocument({ file }: { file: RequirementsFile }) {
  const [markdown, setMarkdown] = useState(() => rendersMarkdown(file));

  return (
    <>
      <div className="flex items-center gap-2 border-b border-line-2 px-4 py-[7px]">
        <Switch
          id="requirements-markdown-switch"
          size="sm"
          checked={markdown}
          onCheckedChange={(next: boolean) => setMarkdown(next)}
          aria-label="Render as markdown"
        />
        <label
          htmlFor="requirements-markdown-switch"
          className="cursor-pointer text-[0.72rem] text-ink-3"
        >
          Render as markdown
        </label>
      </div>
      <div className="px-4 py-3 text-[0.8rem] text-ink-2">
        {markdown ? (
          <MarkdownLite text={file.content} />
        ) : (
          /* React puts the string in as text, so a `<script>` in a document
             reaches the DOM as characters. `whitespace-pre-wrap` keeps every
             space, tab and newline the author typed. */
          <pre className="font-mono text-[0.78rem] whitespace-pre-wrap">{file.content}</pre>
        )}
      </div>
    </>
  );
}

/**
 * The body of one BINARY document.
 *
 * It fetches the bytes through the proxy, because a plain `<a href>` and a
 * plain `<img src>` cannot carry the viewer's token, and the API writes an
 * audit entry naming the person who read the document. The blob URL then
 * feeds the `<img>` or the `<object>`.
 */
function BinaryDocument({ tdId, file }: { tdId: string; file: RequirementsFile }) {
  const kind = inlineKind(file.content_type);
  const [preview, setPreview] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (kind === null) return;
    let url: string | null = null;
    let cancelled = false;
    testDefinitionsApi
      .downloadRequirementsFile(tdId, file.name)
      .then((outcome) => {
        if (cancelled) return;
        url = URL.createObjectURL(outcome.blob);
        setPreview(url);
      })
      .catch((error: unknown) => {
        if (!cancelled) setFailure(messageFor(error));
      });
    return () => {
      cancelled = true;
      setPreview(null);
      if (url !== null) URL.revokeObjectURL(url);
    };
  }, [tdId, file.name, kind]);

  const save = () => {
    setFailure(null);
    setSaving(true);
    testDefinitionsApi
      .downloadRequirementsFile(tdId, file.name)
      .then((outcome) => triggerBrowserDownload(outcome.blob, outcome.filename))
      .catch((error: unknown) => setFailure(messageFor(error)))
      .finally(() => setSaving(false));
  };

  return (
    <div className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2 text-[0.72rem] text-ink-3">
        <span className="font-mono text-ink-2">{file.content_type ?? "unknown type"}</span>
        {typeof file.size_bytes === "number" && <span>· {formatBytes(file.size_bytes)}</span>}
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className={cn(
            "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[9px] py-[4px] text-[0.72rem] font-semibold text-foreground transition-colors",
            "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            "disabled:pointer-events-none disabled:opacity-50",
          )}
        >
          <Download className="size-[12px]" strokeWidth={2.2} />
          {saving ? "Fetching…" : "Download"}
        </button>
      </div>

      {failure !== null && (
        <div role="alert" className="text-[0.72rem] text-red">
          {failure}
        </div>
      )}

      {kind === null && (
        <p className="text-[0.76rem] text-ink-3">
          The browser shows no preview for this type. Download the document to read it.
        </p>
      )}

      {kind === "image" && preview !== null && (
        /* eslint-disable-next-line @next/next/no-img-element -- a blob URL
           carries no host, so the Next image loader can never fetch it. */
        <img
          src={preview}
          alt={file.name}
          className="max-h-[28rem] max-w-full rounded-md border border-line"
        />
      )}

      {kind === "pdf" && preview !== null && (
        <object
          data={preview}
          type={INLINE_PDF_TYPE}
          aria-label={file.name}
          className="h-[28rem] w-full rounded-md border border-line"
        >
          <p className="p-3 text-[0.76rem] text-ink-3">
            This browser shows no PDF inline. Download the document to read it.
          </p>
        </object>
      )}
    </div>
  );
}

export function RequirementsPanel({ tdId, files, className }: RequirementsPanelProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const removeFile = useRemoveRequirementsFile(tdId);

  // The selection follows the served list. A removed document therefore falls
  // back to the first one, and no screen points at a name that went.
  const active = files.find((file) => file.name === selectedName) ?? files[0] ?? null;

  const remove = (file: RequirementsFile) => {
    setFailure(null);
    removeFile.mutate(file.name, {
      onSuccess: () => {
        toast(`Removed ${file.name} from ${tdId}`);
        setSelectedName(null);
      },
      onError: (error) => setFailure(messageFor(error)),
    });
  };

  return (
    <Panel className={className}>
      <PanelHead
        title="Requirements"
        action={
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className={cn(
              "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[11px] py-[5px] text-[0.74rem] font-semibold text-foreground transition-colors",
              "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
            )}
          >
            <Plus className="size-[13px]" strokeWidth={2.4} />
            Add document
          </button>
        }
      />

      {active === null ? (
        <EmptyState message="No requirements document sits on this definition yet." />
      ) : (
        <div className="grid md:grid-cols-[minmax(0,13rem)_minmax(0,1fr)]">
          <ul
            aria-label="Requirements documents"
            className="divide-y divide-line-2 border-b border-line-2 md:border-r md:border-b-0"
          >
            {files.map((file) => (
              <li key={file.name}>
                <button
                  type="button"
                  aria-current={file.name === active.name ? "true" : undefined}
                  onClick={() => {
                    setSelectedName(file.name);
                    setFailure(null);
                  }}
                  className={cn(
                    "flex w-full flex-col items-start gap-1 px-4 py-[9px] text-left transition-colors",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                    file.name === active.name ? "bg-surface-2" : "hover:bg-muted",
                  )}
                >
                  <span className="font-mono text-[0.74rem] break-all text-foreground">
                    {file.name}
                  </span>
                  <SourceBadge source={file.source === "manual" ? "manual" : "api:planning"} />
                </button>
              </li>
            ))}
          </ul>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-2 px-4 py-[9px]">
              <span className="text-[0.74rem] text-ink-3">
                {active.source === "manual" ? (
                  <>
                    Added by{" "}
                    <span className="font-mono text-[0.72rem] text-ink-2">
                      {active.updated_by ?? "unknown"}
                    </span>{" "}
                    · {formatArrival(active.updated_at)}
                  </>
                ) : (
                  <>
                    Owned by the planning system · synced {formatArrival(active.updated_at)} ·
                    never editable here
                  </>
                )}
              </span>
              {active.source === "manual" && (
                <div className="flex items-center gap-2">
                  {/* Typing changes text, so only a TEXT document is editable.
                      Bytes are replaced by uploading the file again, and the
                      API refuses this route for a binary document. */}
                  {!holdsBytes(active) && (
                    <button
                      type="button"
                      aria-label={`Edit ${active.name}`}
                      onClick={() => {
                        setFailure(null);
                        setEditOpen(true);
                      }}
                      className={cn(
                        "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[9px] py-[4px] text-[0.72rem] font-semibold text-foreground transition-colors",
                        "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      )}
                    >
                      <Pencil className="size-[12px]" strokeWidth={2.2} />
                      Edit
                    </button>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${active.name}`}
                    disabled={removeFile.isPending}
                    onClick={() => remove(active)}
                    className={cn(
                      "inline-flex items-center gap-[6px] rounded-md border border-border bg-surface-2 px-[9px] py-[4px] text-[0.72rem] font-semibold text-foreground transition-colors",
                      "hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                      "disabled:pointer-events-none disabled:opacity-50",
                    )}
                  >
                    <Trash2 className="size-[12px]" strokeWidth={2.2} />
                    Remove
                  </button>
                </div>
              )}
            </div>

            {failure !== null && (
              <div role="alert" className="border-b border-line-2 px-4 py-2 text-[0.72rem] text-red">
                {failure}
              </div>
            )}

            {/* The key resets the body state — the markdown switch and the
                fetched preview — when the reader picks another document. */}
            {holdsBytes(active) ? (
              <BinaryDocument key={active.name} tdId={tdId} file={active} />
            ) : (
              <TextDocument key={active.name} file={active} />
            )}
          </div>
        </div>
      )}

      {/* Mounted on demand, so a screen nobody writes on holds no form state.
          The edit dialog is keyed on the name, so it always opens on the
          document the reader has in front of them. */}
      {addOpen && <RequirementsFileDialog tdId={tdId} open onOpenChange={setAddOpen} />}
      {editOpen && active !== null && (
        <RequirementsFileDialog
          key={active.name}
          tdId={tdId}
          file={active}
          open
          onOpenChange={setEditOpen}
        />
      )}
    </Panel>
  );
}

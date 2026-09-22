"use client";

/**
 * Download-file action (contract v1.1 §D — file download, ratified 2026-08-18).
 *
 * Two variants render from one component so both the file-detail header and
 * the files-list row use the same state machine (idle → fetching → done /
 * error). The state machine matches the design brief in the phase spec:
 *
 *   idle  — the button is clickable. Header variant shows label + size,
 *           list variant shows the download icon.
 *   fetching — the button is disabled, aria-busy=true, an inline spinner
 *           replaces the icon. Prevents double-click.
 *   done  — a brief success tick + sonner toast. The toast says "checksum
 *           verified" only when `X-Checksum-State` reads `verified`; every
 *           other file gets a plain "Downloaded". State returns to idle
 *           after ~1.4s so the user can download the file again.
 *   error — a sonner toast with the BE's `detail`; 503 renders a
 *           user-friendly "storage unreachable" message per the spec.
 *
 * A quarantined file disables the button and shows a tooltip explaining why
 * (the BE also returns 403 `not_allowed` on the same file, so this is UX
 * courtesy, not the enforcement point).
 */

import { Check, Download, Loader2 } from "lucide-react";
import { useCallback, useState, type MouseEvent, type KeyboardEvent } from "react";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { triggerBrowserDownload } from "@/lib/api/download";
import { filesApi } from "@/lib/api/files";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

type DownloadState = "idle" | "fetching" | "done";

interface DownloadButtonProps {
  fileId: string;
  filename: string;
  sizeBytes: number;
  quarantined: boolean;
  /** "header" renders the labeled button; "row" renders the icon-only button. */
  variant: "header" | "row";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) {
      return "Storage unreachable — download is available in the deployed environment.";
    }
    return error.detail;
  }
  if (error instanceof Error) return error.message;
  return "Download failed.";
}

export function DownloadButton({
  fileId,
  filename,
  sizeBytes,
  quarantined,
  variant,
}: DownloadButtonProps): React.ReactElement {
  const [state, setState] = useState<DownloadState>("idle");

  const runDownload = useCallback(async () => {
    if (state !== "idle" || quarantined) return;
    setState("fetching");
    try {
      const result = await filesApi.download(fileId, filename);
      triggerBrowserDownload(result.blob, result.filename);
      setState("done");
      // Only the registry's verdict may put the word "verified" on the screen.
      // The toast used to read the digest header, which every file carries,
      // so an `unverified` file — the pipeline registers real ones — claimed a
      // check nobody ran. See `X-Checksum-State` (contract §D).
      const message =
        result.checksumState === "verified"
          ? "Downloaded · checksum verified"
          : "Downloaded";
      toast.success(message, {
        description: result.filename,
      });
      window.setTimeout(() => setState("idle"), 1400);
    } catch (error) {
      setState("idle");
      toast.error("Download failed", { description: errorMessage(error) });
    }
  }, [fileId, filename, quarantined, state]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    // Row variant sits inside a clickable <tr>; never let the anchor navigate.
    event.stopPropagation();
    void runDownload();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    // Also swallow keyboard activation so the row's Enter handler cannot
    // navigate at the same time as the click.
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    }
  };

  const disabled = quarantined || state === "fetching";
  const busy = state === "fetching";
  const done = state === "done";

  if (variant === "row") {
    // Icon-only button for a table row. The aria-label carries the filename so
    // screen readers can distinguish rows.
    const label = quarantined
      ? `Download disabled: ${filename} is quarantined`
      : `Download ${filename}`;
    return (
      <button
        type="button"
        aria-label={label}
        aria-busy={busy}
        disabled={disabled}
        title={
          quarantined
            ? "Quarantined files cannot be downloaded"
            : `Download ${filename} · ${formatBytes(sizeBytes)}`
        }
        onClick={onClick}
        onKeyDown={onKeyDown}
        data-download-state={state}
        className={cn(
          "inline-flex size-7 items-center justify-center rounded-md border border-transparent text-ink-2 outline-none transition-colors",
          "hover:border-border hover:bg-surface-2 hover:text-foreground",
          "focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40",
          "disabled:pointer-events-none disabled:opacity-40",
        )}
      >
        {busy ? (
          <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} />
        ) : done ? (
          <Check className="size-[13px] text-green" strokeWidth={2.4} />
        ) : (
          <Download className="size-[13px]" strokeWidth={2.2} />
        )}
      </button>
    );
  }

  // Header variant: the one filled primary on the file detail header. Every
  // other header control is a quiet secondary or lives in the More menu.
  const label = done
    ? "Downloaded"
    : busy
      ? "Downloading…"
      : `Download · ${formatBytes(sizeBytes)}`;

  return (
    <button
      type="button"
      aria-busy={busy}
      disabled={disabled}
      title={
        quarantined
          ? "Quarantined files cannot be downloaded"
          : `Download ${filename}`
      }
      onClick={onClick}
      data-download-state={state}
      className={cn(
        // Same size recipe as every other detail-header button — `h-7`,
        // `px-2.5`, `text-[0.74rem]`, copied from `run-detail-screen.tsx:474`.
        // Only the fill marks this one as the primary; the geometry must not,
        // or the row reads as buttons from two different systems.
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-accent-fill bg-accent-fill px-2.5 text-[0.74rem] font-semibold whitespace-nowrap text-accent-ink transition-colors",
        "hover:bg-accent-fill-hover",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        "disabled:pointer-events-none disabled:opacity-60",
      )}
    >
      {busy ? (
        <Loader2 className="size-[13px] animate-spin" strokeWidth={2.2} />
      ) : done ? (
        // The tick inherits the accent ink: green sits badly on the fill.
        <Check className="size-[13px]" strokeWidth={2.4} />
      ) : (
        <Download className="size-[13px]" strokeWidth={2.2} />
      )}
      {label}
    </button>
  );
}

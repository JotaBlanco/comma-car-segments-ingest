"use client";

import { useState, type ReactNode } from "react";

interface FileDropZoneProps {
  /** The same function the file input's `onChange` calls. */
  onFile: (file: File) => void;
  children: ReactNode;
}

/**
 * A drop target around a file input (FR-DM-077).
 *
 * A drop hands the first dropped file to `onFile`, the same function the input
 * calls. So a drop and a pick follow one path, and a drop meets every check the
 * input meets. The input stays inside the zone and keeps working, because a
 * keyboard reaches an input and never reaches a drop.
 */
export function FileDropZone({ onFile, children }: FileDropZoneProps) {
  const [over, setOver] = useState(false);

  return (
    <div
      data-testid="file-drop-zone"
      data-over={over || undefined}
      // The browser opens a dropped file in the tab unless both handlers cancel
      // the default, and that navigates the person away from the application.
      onDragOver={(event) => {
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={(event) => {
        // `dragleave` fires again when the pointer crosses on to a child, so
        // clear the tint only when the pointer really left the zone. The
        // related target is null when the pointer leaves the window, and that
        // clears the tint as well.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        // A folder, or text dragged from another page, carries no file. The
        // input takes one file, so a drop of many files takes the first one and
        // ignores the rest.
        const dropped = event.dataTransfer?.files?.[0];
        if (dropped) onFile(dropped);
      }}
      className={`rounded-md border border-dashed p-2 transition-colors ${
        over ? "border-primary bg-accent" : "border-line"
      }`}
    >
      {children}
      <div className="mt-1 text-[0.7rem] text-ink-3">Or drop a file on this box.</div>
    </div>
  );
}

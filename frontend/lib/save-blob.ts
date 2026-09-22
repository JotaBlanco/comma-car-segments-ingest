/**
 * Hand one file to the browser's download (FR-DM-018).
 *
 * The CSV writer and the Excel writer both end here, so the save path exists
 * one time. The hidden-anchor trick is the one the Explore tab uses. The blob
 * URL lives on this origin only, and the bytes never leave the browser.
 */
export function saveBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Some browsers cancel the download if the URL goes on the same tick.
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The name of the saved file, e.g. `test-runs-2026-08-21.csv`. */
export function exportFilename(list: string, extension: string, at: Date = new Date()): string {
  const slug = list.trim().toLowerCase().replace(/\s+/g, "-");
  return `${slug}-${at.toISOString().slice(0, 10)}.${extension}`;
}

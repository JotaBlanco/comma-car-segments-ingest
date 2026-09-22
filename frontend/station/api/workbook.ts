/**
 * A workbook: the Test Manager keeps a dashboard layout under a name and the
 * station draws it. The store takes the handle when the workbook page mounts
 * and hands every change to `onLayout`; nothing of its own is stored then.
 */
export interface WorkbookHandle {
  name: string;
  /** The layout as the Test Manager stored it; the store normalises it. Empty means standard. */
  layout: readonly unknown[];
  onLayout(layout: unknown): void;
}

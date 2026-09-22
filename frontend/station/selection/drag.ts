/** What a drag on a chart does: rescale the window, or mark a period. */
export type DragMode = 'zoom' | 'select';

const KEY = 'fts.drag';

export function isDragMode(v: string | null): v is DragMode {
  return v === 'zoom' || v === 'select';
}

/** Shift flips the mode for one drag, so both are always a gesture away. */
export function dragTarget(mode: DragMode, shift: boolean): DragMode {
  if (!shift) return mode;
  return mode === 'zoom' ? 'select' : 'zoom';
}

export function loadDragMode(): DragMode {
  try {
    const v = localStorage.getItem(KEY);
    return isDragMode(v) ? v : 'zoom';
  } catch {
    return 'zoom';
  }
}

export function storeDragMode(mode: DragMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

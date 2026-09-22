const STRIP_KEY = 'fts.strips.height';

export const STRIP_HEIGHT_DEFAULT = 220;
export const STRIP_HEIGHT_MIN = 80;
export const STRIP_HEIGHT_MAX = 420;

export function clampStripHeight(px: number): number {
  return Math.min(STRIP_HEIGHT_MAX, Math.max(STRIP_HEIGHT_MIN, Math.round(px)));
}

export function loadStripHeight(): number {
  try {
    const n = Number(localStorage.getItem(STRIP_KEY));
    return Number.isFinite(n) && n > 0 ? clampStripHeight(n) : STRIP_HEIGHT_DEFAULT;
  } catch {
    return STRIP_HEIGHT_DEFAULT;
  }
}

export function storeStripHeight(px: number): void {
  try {
    localStorage.setItem(STRIP_KEY, String(clampStripHeight(px)));
  } catch {
    /* storage blocked: the height lasts for this page only */
  }
}

export function clearStoredStripHeight(): void {
  try {
    localStorage.removeItem(STRIP_KEY);
  } catch {
    /* storage blocked: nothing was stored to clear */
  }
}

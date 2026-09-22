const OPEN_KEY = 'fts.tree';
const WIDTH_KEY = 'fts.tree.width';
export const TREE_WIDTH_DEFAULT = 300;
export const TREE_WIDTH_MIN = 220;
export const TREE_WIDTH_MAX = 480;

export function clampTreeWidth(px: number): number {
  return Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, Math.round(px)));
}

export function loadTreeOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export function storeTreeOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
}

export function loadTreeWidth(): number {
  try {
    const n = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(n) && n > 0 ? clampTreeWidth(n) : TREE_WIDTH_DEFAULT;
  } catch {
    return TREE_WIDTH_DEFAULT;
  }
}

export function storeTreeWidth(px: number): void {
  try {
    localStorage.setItem(WIDTH_KEY, String(clampTreeWidth(px)));
  } catch {
    /* storage blocked: the width lasts for this page only */
  }
}

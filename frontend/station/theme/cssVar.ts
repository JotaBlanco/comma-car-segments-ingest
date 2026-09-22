/** Resolved CSS custom property: Leaflet and SVG need literals. */
export function readCssVar(name: string, fallback = ''): string {
  const root = document.querySelector('.fts-root') ?? document.documentElement;
  return getComputedStyle(root).getPropertyValue(name).trim() || fallback;
}

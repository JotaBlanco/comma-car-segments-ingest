/**
 * One title format for both title paths (FR-DM-091).
 *
 * Server routes get their title through the `title.template` in
 * `app/layout.tsx`; the client-side detail screens set `document.title`
 * through `usePageTitle`. Both compose the same string, so a run reads
 * "TAS-88214 — test run — Test Manager" whichever way it arrived.
 */
export const TITLE_SUFFIX = "Test Manager";

export function pageTitle(title: string): string {
  return `${title} — ${TITLE_SUFFIX}`;
}

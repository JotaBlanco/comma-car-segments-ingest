/**
 * Where an issue lives: its own page.
 *
 * `from` names the run whose Issues tab opened it, so the page's back control returns to
 * that tab rather than to a list the person never used. Without it the issue came from the
 * Issues page, and back goes there.
 */
export function issueHref(id: number, from?: string | null): string {
  const base = `/issues/${encodeURIComponent(String(id))}`;
  return from ? `${base}?from=${encodeURIComponent(from)}` : base;
}

/**
 * The one link rule (AS-5): the assistant only ever navigates app-relative.
 * "/runs?…" passes; "https://…" fails; so does "//evil.example", which a
 * browser would treat as protocol-relative and leave the app with.
 */
export function isAppRelativeUrl(url: string): boolean {
  return url.startsWith("/") && !url.startsWith("//");
}

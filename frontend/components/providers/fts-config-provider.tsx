"use client";

import type { ReactNode } from "react";
import { setFtsConfig } from "@/lib/fts";

/**
 * Hand the server's Flight Test Station config down to the browser.
 *
 * The setter runs during render, not in an effect: the panel reads
 * `ftsConfigured()` during its own render, and an effect here would run too
 * late, so the panel would hide on the first paint. `QuixLabConfigProvider`
 * does the same for the same reason.
 */
export function FtsConfigProvider({
  url,
  origin,
  children,
}: {
  url: string;
  origin: string;
  children: ReactNode;
}) {
  setFtsConfig(url, origin);
  return <>{children}</>;
}

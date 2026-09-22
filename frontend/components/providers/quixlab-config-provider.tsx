"use client";

import type { ReactNode } from "react";
import { setQuixLabUrl } from "@/lib/quixlab";

/**
 * Hand the server's QuixLab URL down to the browser.
 *
 * `app/layout.tsx` resolves the URL on the server, through
 * `lib/quixlab-server.ts`, and passes it here as a prop. The API owns the value
 * and answers it on `GET /api/v1/integrations/quixlab-url`, so this front end
 * reads no QuixLab name of its own and `next build` bakes no value into the
 * image. `PortalConfigProvider` carries `Quix__Portal__Api` the same way.
 *
 * **The setter runs during render, not in an effect.** The four QuixLab
 * controls read `quixLabConfigured()` during their own render, and a child
 * renders after its parent. An effect here would run too late, so the controls
 * would hide on the first paint. `setQuixLabUrl` writes one module variable, so
 * a repeated render costs nothing and changes nothing.
 */
export function QuixLabConfigProvider({
  url,
  children,
}: {
  url: string;
  children: ReactNode;
}) {
  setQuixLabUrl(url);
  return <>{children}</>;
}

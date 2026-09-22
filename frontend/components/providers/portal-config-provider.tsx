"use client";

import type { ReactNode } from "react";
import { setPortalApiBase } from "@/lib/portal/client";

/**
 * Hand the server's Portal API base URL down to the browser.
 *
 * The platform injects `Quix__Portal__Api` into every deployment, and that
 * variable reaches the **server** process only. The front end runs a server, so
 * `app/layout.tsx` reads the variable and passes it here as a prop. No build
 * argument exists and no `NEXT_PUBLIC_` name exists.
 *
 * **The setter runs during render, not in an effect.** A child effect runs
 * before a parent effect, and `usePortalAuth` reads the Portal origin in a
 * child effect on mount. An effect here would therefore run too late.
 * `setPortalApiBase` writes one module variable, so a repeated render costs
 * nothing and changes nothing.
 */
export function PortalConfigProvider({
  base,
  children,
}: {
  base: string;
  children: ReactNode;
}) {
  setPortalApiBase(base);
  return <>{children}</>;
}

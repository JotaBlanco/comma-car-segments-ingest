"use client";

import type { ReactNode } from "react";
import { setLakePartitions } from "@/lib/explore/lake-partitions";
import { setLakeTable } from "@/lib/explore/lake-schema";

/**
 * Hand the server's physical lake table name down to the browser.
 *
 * `app/layout.tsx` reads `TM_LAKE_TABLE` on the server at request time and
 * passes it here as a prop, so the Explore workbench names the REAL table the
 * lake resolves — no `NEXT_PUBLIC_` name exists and `next build` bakes no
 * value into the image. `PortalConfigProvider` carries `Quix__Portal__Api`
 * the same way. An empty value means "unset", and the local stack's physical
 * name applies (`lib/explore/lake-schema.ts`).
 *
 * **The setter runs during render, not in an effect.** The Explore tab reads
 * `lakeTable()` during its own render, and a child renders after its parent.
 * An effect here would run too late, so the first paint would show the
 * fallback name. `setLakeTable` writes one module variable, so a repeated
 * render costs nothing and changes nothing.
 */
export function LakeConfigProvider({
  table,
  sessionPartitions = "",
  dataPartitions = "",
  children,
}: {
  table: string;
  /** `TM_LAKE_SESSION_PARTITIONS` — the levels that address a session. */
  sessionPartitions?: string;
  /** `TM_LAKE_DATA_PARTITIONS` — the levels inside one session. */
  dataPartitions?: string;
  children: ReactNode;
}) {
  setLakeTable(table);
  setLakePartitions(sessionPartitions, dataPartitions);
  return <>{children}</>;
}

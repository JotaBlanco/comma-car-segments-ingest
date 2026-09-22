"use client";

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { getLakehouseUrl } from "@/lib/api/integrations";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

/**
 * The Portal's Lakehouse page for this workspace, framed in the content area.
 *
 * No token passes to it and no message: that page signs its own viewer in, the
 * same way it does when the Portal shows it. An empty URL means this
 * deployment could not derive the Portal web host, and the sidebar then shows
 * no Lakehouse row either.
 */
export function LakehouseScreen() {
  /* `null` while the call is in flight, `""` once it answered no URL. */
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    function settle(answer: string) {
      if (live) setUrl(answer);
    }
    // A refused call is a signed-out viewer, and that shows the same empty state.
    getLakehouseUrl().then(settle, () => settle(""));
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className={SHELL_BREAKOUT_CLASS}>
      {url === null && <EmptyState message="Resolving the Lakehouse…" />}
      {url === "" && (
        <EmptyState
          title="No Lakehouse"
          message="This deployment resolved no Lakehouse page for this workspace."
        />
      )}
      {url !== null && url.length > 0 && (
        <iframe src={url} title="Lakehouse" className="w-full flex-1 border-0" />
      )}
    </div>
  );
}

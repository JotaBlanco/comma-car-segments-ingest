"use client";

import { useEffect, useState } from "react";
import { EmptyState } from "@/components/shared/empty-state";
import { QuixLabFrame } from "@/components/shared/quixlab-frame";
import { listQuixLabs } from "@/lib/api/integrations";
import { workspaceQuixLab, type QuixLabInstance } from "@/lib/quixlab";
import { SHELL_BREAKOUT_CLASS } from "@/lib/shell-breakout";

/** What the page shows once the list settles: the frame, or why there is none. */
function body(lab: QuixLabInstance | null | undefined) {
  if (lab === undefined) {
    return <EmptyState message="Resolving the workspace QuixLab…" />;
  }
  if (lab === null) {
    return (
      <EmptyState
        title="No QuixLab"
        message="This deployment resolved no QuixLab, so there is nothing to frame."
      />
    );
  }
  return (
    <QuixLabFrame
      embedUrl={lab.embed_url}
      origin={lab.origin}
      title={`QuixLab - ${lab.name}`}
      fill
    />
  );
}

/**
 * The workspace QuixLab, framed in the content area.
 *
 * No run reaches it: a run-scoped frame belongs to the run, and the run detail
 * panel is where a person picks one. This page is the global entry, the place
 * the sidebar row leads to.
 */
export function QuixLabScreen() {
  /* `undefined` while the list is in flight. `listQuixLabs` waits for the
     viewer's Portal token first, so the answer can be a few seconds away, and
     an empty frame in the meantime reads as a broken page. */
  const [lab, setLab] = useState<QuixLabInstance | null | undefined>(undefined);

  useEffect(() => {
    let live = true;
    function settle(found: QuixLabInstance[]) {
      if (live) setLab(workspaceQuixLab(found));
    }
    // A refusal and an outage both leave the configured QuixLab, which is what
    // `workspaceQuixLab` answers for an empty list.
    listQuixLabs().then(settle, () => settle([]));
    return () => {
      live = false;
    };
  }, []);

  /* Edge to edge in the content area, the way a workbook's station is: a
     framed app brings its own chrome and the page adds none. */
  return <div className={SHELL_BREAKOUT_CLASS}>{body(lab)}</div>;
}

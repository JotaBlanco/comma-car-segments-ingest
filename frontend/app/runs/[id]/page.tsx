import { Suspense } from "react";
import { RunDetailScreen } from "@/components/screens/run-detail/run-detail-screen";

export default async function RunDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const runId = decodeURIComponent(id);
  return (
    // Suspense because the screen reads `useSearchParams` (the active tab
    // lives in the URL) — same shape as the list pages.
    //
    // `key={runId}` remounts the whole screen when the run changes. Without
    // it, run A → run B (run B already in the react-query cache) keeps run
    // A's subtree mounted: ExploreTab's reducer was initialized from run A's
    // localStorage, and its debounced save would then write run A's tabs
    // under run B's key. The key also resets every other per-run state
    // (focus mode, dialogs, lazy-mounted panes).
    <Suspense>
      <RunDetailScreen key={runId} runId={runId} />
    </Suspense>
  );
}

import { Suspense } from "react";
import { WorkbookScreen } from "@/components/screens/workbooks/workbook-screen";

export default async function WorkbookPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const workbookId = decodeURIComponent(id);
  return (
    // Suspense because the screen reads `useSearchParams` (the run, the
    // signals and the period the workbook opened for live in the URL).
    <Suspense>
      <WorkbookScreen key={workbookId} workbookId={workbookId} />
    </Suspense>
  );
}

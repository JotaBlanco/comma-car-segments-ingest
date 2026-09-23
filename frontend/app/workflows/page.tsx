import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkflowsScreen } from "@/components/screens/workflows/workflows-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Workflows" };

export default function WorkflowsPage() {
  return (
    <Suspense>
      <WorkflowsScreen />
    </Suspense>
  );
}

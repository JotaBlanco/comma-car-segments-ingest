import type { Metadata } from "next";
import { Suspense } from "react";
import { RunsScreen } from "@/components/screens/runs/runs-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Test runs" };

export default function RunsPage() {
  return (
    <Suspense>
      <RunsScreen />
    </Suspense>
  );
}

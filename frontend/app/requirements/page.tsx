import type { Metadata } from "next";
import { Suspense } from "react";
import { RequirementsScreen } from "@/components/screens/requirements/requirements-screen";

export const metadata: Metadata = { title: "Requirements" };

export default function RequirementsPage() {
  return (
    <Suspense>
      <RequirementsScreen />
    </Suspense>
  );
}

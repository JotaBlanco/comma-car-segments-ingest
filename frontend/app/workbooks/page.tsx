import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkbooksScreen } from "@/components/screens/workbooks/workbooks-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Workbooks" };

export default function WorkbooksPage() {
  return (
    <Suspense>
      <WorkbooksScreen />
    </Suspense>
  );
}

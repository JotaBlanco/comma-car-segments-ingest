import type { Metadata } from "next";
import { Suspense } from "react";
import { IssuesScreen } from "@/components/screens/issues/issues-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Issues" };

export default function IssuesPage() {
  return (
    <Suspense>
      <IssuesScreen />
    </Suspense>
  );
}

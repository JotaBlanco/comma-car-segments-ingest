import type { Metadata } from "next";
import { Suspense } from "react";
import { AuditScreen } from "@/components/screens/audit/audit-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Audit" };

export default function AuditPage() {
  return (
    <Suspense>
      <AuditScreen />
    </Suspense>
  );
}

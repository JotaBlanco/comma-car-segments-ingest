import type { Metadata } from "next";
import { Suspense } from "react";
import { WorkOrdersScreen } from "@/components/screens/work-orders/work-orders-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Work orders" };

export default function WorkOrdersPage() {
  return (
    <Suspense>
      <WorkOrdersScreen />
    </Suspense>
  );
}

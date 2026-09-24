import type { Metadata } from "next";
import { TraceabilityScreen } from "@/components/screens/traceability/traceability-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Traceability" };

export default function TraceabilityPage() {
  return <TraceabilityScreen />;
}

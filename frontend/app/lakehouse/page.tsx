import type { Metadata } from "next";
import { LakehouseScreen } from "@/components/screens/lakehouse/lakehouse-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Lakehouse" };

export default function LakehousePage() {
  return <LakehouseScreen />;
}

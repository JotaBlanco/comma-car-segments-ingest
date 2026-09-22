import type { Metadata } from "next";
import { QuixLabScreen } from "@/components/screens/quixlab/quixlab-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "QuixLab" };

export default function QuixLabPage() {
  return <QuixLabScreen />;
}

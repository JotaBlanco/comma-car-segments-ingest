import type { Metadata } from "next";
import { pageTitle } from "@/lib/page-title";
import { HomeScreen } from "@/components/screens/home/home-screen";

/* The root page and the root layout share a segment, and a layout's
   title.template applies to CHILD segments only (Next docs,
   generate-metadata.md) — so this one states the full title itself. */
export const metadata: Metadata = { title: { absolute: pageTitle("Home") } };

export default function HomePage() {
  return <HomeScreen />;
}

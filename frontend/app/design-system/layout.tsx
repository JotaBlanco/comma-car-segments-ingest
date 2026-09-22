import type { Metadata } from "next";
import type { ReactNode } from "react";

/* The page itself is a client component, so the segment title lives here.
   The layout template appends the product name. */
export const metadata: Metadata = { title: "Design system" };

export default function DesignSystemLayout({ children }: { children: ReactNode }) {
  return children;
}

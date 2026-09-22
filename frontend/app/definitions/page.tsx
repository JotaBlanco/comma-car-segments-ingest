import type { Metadata } from "next";
import { Suspense } from "react";
import { DefinitionsScreen } from "@/components/screens/definitions/definitions-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Test definitions" };

export default function DefinitionsPage() {
  return (
    <Suspense>
      <DefinitionsScreen />
    </Suspense>
  );
}

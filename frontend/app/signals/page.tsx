import type { Metadata } from "next";
import { Suspense } from "react";
import { SignalsScreen } from "@/components/screens/signals/signals-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Signals" };

export default function SignalsPage() {
  return (
    <Suspense>
      <SignalsScreen />
    </Suspense>
  );
}

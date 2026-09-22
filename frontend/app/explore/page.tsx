import type { Metadata } from "next";
import { Suspense } from "react";
import { ExploreScreen } from "@/components/screens/explore/explore-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Explore" };

export default function ExplorePage() {
  return (
    <Suspense>
      <ExploreScreen />
    </Suspense>
  );
}

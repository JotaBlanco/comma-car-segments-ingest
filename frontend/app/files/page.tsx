import type { Metadata } from "next";
import { Suspense } from "react";
import { FilesScreen } from "@/components/screens/files/files-screen";

/* The segment names itself; the layout template appends the product name. */
export const metadata: Metadata = { title: "Files" };

export default function FilesPage() {
  return (
    <Suspense>
      <FilesScreen />
    </Suspense>
  );
}

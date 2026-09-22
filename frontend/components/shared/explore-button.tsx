"use client";

import { Compass } from "lucide-react";
import Link from "next/link";
import { buttonVariants } from "@/components/ui/button";
import { exploreHref, type ExploreEntry } from "@/lib/explore/entry";
import { cn } from "@/lib/utils";

/** "Open in Explorer": the signal explorer over the lake, rooted on this run, or on this issue. */
export function ExploreButton({
  entry,
  iconOnly = false,
  label = "Open in Explorer",
}: {
  entry: ExploreEntry;
  iconOnly?: boolean;
  label?: string;
}) {
  return (
    <Link
      href={exploreHref(entry)}
      className={cn(
        buttonVariants({ variant: iconOnly ? "ghost" : "outline", size: iconOnly ? "icon-xs" : "sm" }),
        !iconOnly && "font-semibold",
      )}
      aria-label={label}
      title={label}
      onClick={(e) => e.stopPropagation()}
    >
      <Compass />
      {!iconOnly && label}
    </Link>
  );
}

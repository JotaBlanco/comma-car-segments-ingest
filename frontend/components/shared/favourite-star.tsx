"use client";

import { Star } from "lucide-react";
import { toggleFavourite, useIsFavourite, type FavouriteType } from "@/lib/favourites";
import { cn } from "@/lib/utils";

interface FavouriteStarProps {
  /** The entity type. It pairs with `id` to name one entity. */
  readonly type: FavouriteType;
  /** The run id, the file id or the signal name. */
  readonly id: string;
  /** What the Home panel prints. Pass the heading a person reads here. */
  readonly label: string;
  readonly className?: string;
}

/**
 * One star, on every detail header (FR-DM-075).
 *
 * The Explore star is the pattern (explore-tab/history-panel.tsx): a button
 * that carries `aria-pressed`, and a device-local store behind it. The name
 * states the entity, so a screen reader hears which row the star holds, and
 * the axe suite gets a real accessible name instead of an icon.
 */
export function FavouriteStar({ type, id, label, className }: FavouriteStarProps) {
  const favourite = useIsFavourite(type, id);
  return (
    <button
      type="button"
      aria-pressed={favourite}
      aria-label={favourite ? `Remove ${label} from favorites` : `Add ${label} to favorites`}
      title={favourite ? "Remove from favorites" : "Add to favorites"}
      onClick={() => toggleFavourite(type, id, label)}
      className={cn(
        "inline-flex size-7 flex-none items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
        favourite && "text-amber-dot hover:text-amber-dot",
        className,
      )}
    >
      <Star
        className="size-[15px]"
        strokeWidth={2.2}
        fill={favourite ? "currentColor" : "none"}
        aria-hidden
      />
    </button>
  );
}

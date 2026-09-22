"use client";

import { Star } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { FAVOURITE_TYPE_LABEL, favouriteHref, useFavourites } from "@/lib/favourites";
import { SAVED_SEARCH_SCOPE, useMergedSavedSearches } from "@/lib/hooks/use-saved-searches";

/**
 * Favorites and saved searches, on every screen (FR-DM-075, FR-DM-017).
 *
 * Both lists already exist. The Home panel lists the favorites, and each list
 * screen lists its own saved searches on its own toolbar. Neither one reaches
 * a person who is three screens away, so this menu puts both in the topbar.
 *
 * It copies the notification bell whole (`components/shell/notification-bell.tsx`):
 * the same popover, the same trigger shape, the same row link that shuts the
 * panel on click. Base UI's popover owns `aria-expanded`, the Escape key and
 * the focus return, so no key handler here can get them wrong.
 *
 * **The saved searches come from two stores, and one hook merges them.**
 * `useMergedSavedSearches` holds that whole rule: every device scope, every
 * server scope, server rows first and device rows after. The Home panel prints
 * the same list from the same hook, so the same person reads one list in both
 * places, and a fifth scope changes one file.
 *
 * The four server queries stay off until a person opens the panel, so a page
 * load fires none of them. They also share their keys with the toolbar button
 * and with the Home panel, so a second reader costs no second request.
 */

/**
 * How many rows one section prints. The stores cap at 50 favorites and 30
 * saved searches, and a menu that scrolls for ever is not a menu. The header
 * counts every row, so nothing is ever hidden in silence.
 */
const MAX_ROWS = 8;

const SECTION_HEAD =
  "flex items-baseline gap-2 border-b border-line px-3 py-2 text-[0.72rem] font-semibold tracking-[0.04em] text-ink-3 uppercase";

const ROW_LINK =
  "flex items-baseline gap-3 px-3 py-2 no-underline outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

/** The count beside a section title, and the sentence that says what is cut. */
function shownOf(total: number): string {
  return total > MAX_ROWS ? `${MAX_ROWS} of ${total}` : String(total);
}

export function FavouritesMenu() {
  const favourites = useFavourites();
  const [open, setOpen] = useState(false);

  /* `open` holds the four server queries shut until a person asks for the
     list. A signed-out person runs no query at all, so the device rows stand
     alone. A failed read never empties the list; it only adds the line below
     the rows. */
  const { rows: searches, serverFailed } = useMergedSavedSearches(open);

  const label =
    `Favorites and saved searches — ` +
    `${favourites.length} ${favourites.length === 1 ? "favorite" : "favorites"}, ` +
    `${searches.length} saved ${searches.length === 1 ? "search" : "searches"}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="relative grid size-7 place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <Star size={14} strokeWidth={2} aria-hidden />
      </PopoverTrigger>
      {/* Escape shuts the panel and returns focus to the button. Base UI's
          popover owns both, exactly as it does for the bell. */}
      <PopoverContent align="end" sideOffset={8} className="w-96 gap-0 p-0">
        <div className={SECTION_HEAD}>
          Favorites
          {favourites.length > 0 && (
            <span className="ml-auto font-normal tracking-normal normal-case tabular-nums">
              {shownOf(favourites.length)}
            </span>
          )}
        </div>
        {favourites.length === 0 ? (
          <p className="px-3 py-4 text-[0.8rem] text-ink-3">
            No favorites yet. Star a run, a file, a signal, a work order or a test definition on
            its detail screen. The list stays on this device.
          </p>
        ) : (
          <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
            {favourites.slice(0, MAX_ROWS).map((favourite) => (
              <li
                key={`${favourite.type}:${favourite.id}`}
                className="border-b border-line-2 last:border-0"
              >
                {/* A click leaves for the entity, so the panel shuts. */}
                <Link
                  href={favouriteHref(favourite)}
                  onClick={() => setOpen(false)}
                  className={ROW_LINK}
                >
                  <span
                    title={favourite.label}
                    className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-ink"
                  >
                    {favourite.label}
                  </span>
                  <span className="shrink-0 text-[0.68rem] whitespace-nowrap text-ink-3">
                    {FAVOURITE_TYPE_LABEL[favourite.type]}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {favourites.length > MAX_ROWS && (
          <p className="border-b border-line px-3 py-1.5 text-[0.68rem] text-ink-3">
            {favourites.length - MAX_ROWS} more favorites. Home lists them all.
          </p>
        )}

        <div className={`${SECTION_HEAD} border-t`}>
          Saved searches
          {searches.length > 0 && (
            <span className="ml-auto font-normal tracking-normal normal-case tabular-nums">
              {shownOf(searches.length)}
            </span>
          )}
        </div>
        {searches.length === 0 ? (
          <p className="px-3 py-4 text-[0.8rem] text-ink-3">
            No saved search yet. Set the filters you want on a list screen, then name them with
            the Saved searches button there.
          </p>
        ) : (
          <ul className="m-0 max-h-64 list-none overflow-y-auto p-0">
            {searches.slice(0, MAX_ROWS).map((search) => (
              <li key={search.key} className="border-b border-line-2 last:border-0">
                {/* Two screens can hold one name, so the row says which one. */}
                <Link
                  href={`${SAVED_SEARCH_SCOPE[search.scope].pathname}${search.query}`}
                  onClick={() => setOpen(false)}
                  className={ROW_LINK}
                  aria-label={`Apply the saved search ${search.name} on ${SAVED_SEARCH_SCOPE[search.scope].label}`}
                >
                  <span title={search.name} className="min-w-0 flex-1 truncate text-[0.78rem] text-ink">
                    {search.name}
                  </span>
                  <span className="shrink-0 text-[0.68rem] whitespace-nowrap text-ink-3">
                    {SAVED_SEARCH_SCOPE[search.scope].label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {searches.length > MAX_ROWS && (
          <p className="px-3 py-1.5 text-[0.68rem] text-ink-3">
            {searches.length - MAX_ROWS} more saved searches. Each list screen holds its own.
          </p>
        )}
        {/* The same words the toolbar button uses for the same failure. */}
        {serverFailed && (
          <p role="alert" className="px-3 py-1.5 text-[0.68rem] leading-snug text-red">
            The shared list did not load. The searches on this device are still here.
          </p>
        )}
      </PopoverContent>
    </Popover>
  );
}

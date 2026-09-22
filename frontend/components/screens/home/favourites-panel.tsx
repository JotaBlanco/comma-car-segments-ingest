"use client";

import { X } from "lucide-react";
import { EmptyState } from "@/components/shared/empty-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatArrival } from "@/lib/format";
import {
  FAVOURITE_TYPE_LABEL,
  favouriteHref,
  favouritesPersist,
  removeFavourite,
  useFavourites,
} from "@/lib/favourites";

/**
 * The Home favourites panel (FR-DM-075).
 *
 * The list is device-local, exactly like the Explore star it copies, so the
 * panel never loads and never fails. It states that in the empty case, because
 * a person who starred a run on another machine deserves the reason.
 */
export function FavouritesPanel() {
  const favourites = useFavourites();
  const persists = favouritesPersist();

  return (
    <Panel>
      <PanelHead
        title="Favorites"
        action={
          <span className="text-[0.72rem] text-ink-3">
            {favourites.length > 0 ? `${favourites.length} starred` : "This device"}
          </span>
        }
      />
      <Table aria-label="Favorites">
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Starred</TableHead>
            <TableHead className="w-10" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {favourites.length === 0 && (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4} className="p-0!">
                <EmptyState
                  title="No favorites yet"
                  message="Star a run, a file, a signal, a work order or a test definition on its detail screen. The list stays on this device."
                />
              </TableCell>
            </TableRow>
          )}
          {favourites.map((favourite) => (
            <RowLink key={`${favourite.type}:${favourite.id}`} href={favouriteHref(favourite)}>
              <TableCell>
                <RowLinkLabel>
                  <span className="font-mono text-[0.78rem]">{favourite.label}</span>
                </RowLinkLabel>
              </TableCell>
              <TableCell>{FAVOURITE_TYPE_LABEL[favourite.type]}</TableCell>
              <TableCell>{formatArrival(new Date(favourite.at).toISOString())}</TableCell>
              <TableCell>
                <button
                  type="button"
                  aria-label={`Remove ${favourite.label} from favorites`}
                  onClick={() => removeFavourite(favourite.type, favourite.id)}
                  className="inline-flex size-6 items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-red-bg hover:text-red focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                >
                  <X className="size-[13px]" strokeWidth={2.2} aria-hidden />
                </button>
              </TableCell>
            </RowLink>
          ))}
        </TableBody>
      </Table>
      {!persists && (
        <div className="border-t border-line-2 px-4 py-2 text-[0.72rem] text-ink-3">
          This browser refuses storage, so the list ends with the tab.
        </div>
      )}
    </Panel>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bookmark, Check, Pencil, Trash2, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  MAX_DESCRIPTION_LENGTH,
  removeSavedSearch,
  renameSavedSearch,
  saveSearch,
  savedSearchesPersist,
  useSavedSearches,
  type SavedSearchScope,
} from "@/lib/saved-searches";
import {
  ownsSavedSearch,
  useDeleteServerSearch,
  useSaveServerSearch,
  useSearchIdentity,
  useServerSavedSearches,
} from "@/lib/hooks/use-saved-searches";
import type { SavedSearchVisibility } from "@/types";
import { cn } from "@/lib/utils";

interface SavedSearchButtonProps {
  /** The screen that owns this list. It names the storage key and the scope. */
  readonly scope: SavedSearchScope;
  /** The list path a saved search returns to, e.g. `/runs`. */
  readonly pathname: string;
  /** The canonical query string for the filters on screen right now. */
  readonly query: string;
  readonly className?: string;
}

const ROW_BUTTON =
  "inline-flex size-6 flex-none items-center justify-center rounded-md text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring";

/** Where one row lives. The two stores never merge, so the row says which. */
type RowOrigin = "device" | "server";

interface Row {
  readonly key: string;
  readonly id: string;
  readonly origin: RowOrigin;
  readonly name: string;
  /** Why the search exists. Empty when nobody wrote a description. */
  readonly description: string;
  readonly query: string;
  /** The word a person reads on the row. Never a color alone. */
  readonly mark: string;
  /** The phrase the accessible name of the apply button carries. */
  readonly markPhrase: string;
  /** The sentence the delete confirmation states. */
  readonly cost: string;
  readonly canRename: boolean;
  readonly canDelete: boolean;
}

/**
 * Save the filters on screen under a name, share them with the team, and go
 * back to them later (FR-DM-017; UC-004 clause 5).
 *
 * Every list keeps its whole filter, sort, search and page state in the query
 * string (lib/table-state.ts), so a saved search is a name plus that string,
 * and applying one only sets the URL. Each screen owns its own list, so a runs
 * filter can never land on the files screen.
 *
 * **Two stores serve this one list, and neither one replaces the other.**
 *
 *  - `lib/saved-searches.ts` keeps a search in this browser. Every row a
 *    person saved before this control reached the server is still there, and
 *    this panel still lists it, renames it and deletes it. Nothing migrates
 *    and nothing is dropped.
 *  - The three routes at contract §D DS-9 keep a search for a Quix account. A
 *    `personal` row answers to its owner. A `team` row reaches every colleague
 *    this registry serves.
 *
 * A signed-in person saves to the server, because a server row follows them to
 * the next browser. With no Quix identity there is nobody to own a row, so the
 * save goes to the device and the panel says so. The routes are never called
 * without an actor, so a signed-out person never sees a broken team list.
 *
 * **The delete control follows the route, never the wish.** The route lets the
 * owner alone delete, on a `team` row as well (`api/api/routers/searches.py`),
 * so a row this caller does not own carries no delete control at all.
 */
export function SavedSearchButton({ scope, pathname, query, className }: SavedSearchButtonProps) {
  const router = useRouter();
  const deviceSearches = useSavedSearches(scope);
  const identity = useSearchIdentity();
  const server = useServerSavedSearches(scope, identity);
  const saveOnServer = useSaveServerSearch(scope, identity);
  const deleteOnServer = useDeleteServerSearch(identity);

  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<SavedSearchVisibility>("personal");
  /** The row a person renames right now. */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  /** The row that asks for a delete confirmation right now. */
  const [confirmKey, setConfirmKey] = useState<string | null>(null);

  const signedIn = identity.actor !== null;
  const persists = savedSearchesPersist(scope);

  const serverRows: Row[] = (server.data?.items ?? []).map((entry) => {
    const mine = ownsSavedSearch(entry, identity);
    const team = entry.visibility === "team";
    return {
      key: `server:${entry.search_id}`,
      id: entry.search_id,
      origin: "server",
      name: entry.name,
      description: entry.description ?? "",
      query: entry.query,
      mark: team ? "Team" : "Personal",
      markPhrase: team
        ? mine
          ? "your team search"
          : `a team search from ${entry.owner}`
        : "your personal search",
      cost: team
        ? "Everybody here loses it. The rows on screen do not change."
        : "This removes the name and the filters it holds. The rows on screen do not change.",
      canRename: false,
      canDelete: mine,
    };
  });

  const deviceRows: Row[] = deviceSearches.map((entry) => ({
    key: `device:${entry.id}`,
    id: entry.id,
    origin: "device",
    name: entry.name,
    description: entry.description ?? "",
    query: entry.query,
    mark: "This device",
    markPhrase: "saved on this device",
    cost: "This removes the name and the filters it holds. The rows on screen do not change.",
    canRename: true,
    canDelete: true,
  }));

  const rows = [...serverRows, ...deviceRows];
  const count = rows.length;

  const openChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      // A reopened popover starts clean, never mid-rename.
      setName("");
      setDescription("");
      setRenamingId(null);
      setConfirmKey(null);
      saveOnServer.reset();
    }
  };

  const save = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    // The description is optional, so a blank one saves as no description.
    const written = description.trim();
    const clear = () => {
      setName("");
      setDescription("");
    };
    if (!signedIn) {
      if (saveSearch(scope, trimmed, query, written) === null) return;
      clear();
      return;
    }
    saveOnServer.mutate(
      { name: trimmed, description: written === "" ? null : written, query, visibility },
      { onSuccess: clear },
    );
  };

  const apply = (savedQuery: string) => {
    router.push(`${pathname}${savedQuery}`, { scroll: false });
    openChange(false);
  };

  const startRename = (id: string, current: string) => {
    setConfirmKey(null);
    setRenamingId(id);
    setRenameText(current);
  };

  const commitRename = (id: string) => {
    renameSavedSearch(scope, id, renameText);
    setRenamingId(null);
  };

  const remove = (row: Row) => {
    if (row.origin === "device") removeSavedSearch(scope, row.id);
    else deleteOnServer.mutate(row.id);
    setConfirmKey(null);
  };

  return (
    <Popover open={open} onOpenChange={openChange}>
      <PopoverTrigger
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={
          count === 0 ? "Saved searches — none saved yet" : `Saved searches — ${count} saved`
        }
        className={cn(
          "inline-flex flex-none items-center gap-[6px] rounded-md border border-border bg-surface px-[11px] py-[5px] text-[0.76rem] font-semibold text-ink-2 transition-colors",
          "hover:bg-surface-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
          className,
        )}
      >
        <Bookmark className="size-[13px]" strokeWidth={2.2} />
        Saved searches
        {count > 0 && (
          <span className="rounded-lg bg-surface-2 px-1.5 font-mono text-[0.64rem] leading-[1.5] text-ink-2">
            {count}
          </span>
        )}
      </PopoverTrigger>

      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-80 gap-0 p-1.5"
        aria-label="Saved searches"
      >
        <div className="px-2 py-1 text-[0.62rem] font-bold tracking-[0.08em] text-ink-3 uppercase">
          Saved searches
        </div>

        <form
          className="px-1 pb-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={name}
              maxLength={60}
              aria-label="Name this search"
              placeholder="Name the filters on screen…"
              className="h-7 min-w-0 flex-1 rounded-md border border-input bg-surface px-2 text-[0.76rem] outline-none placeholder:text-ink-3 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              onChange={(event) => setName(event.target.value)}
            />
            <button
              type="submit"
              disabled={name.trim().length === 0 || saveOnServer.isPending}
              className="rounded-md border border-primary bg-accent-soft px-2 py-1 text-[0.7rem] font-semibold text-primary transition-colors hover:text-accent-fill-hover focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:cursor-not-allowed disabled:border-line disabled:bg-surface disabled:text-ink-3"
            >
              Save
            </button>
          </div>

          {/* The description is optional, and the label says so on screen. A
              real label stays there while a person types; a placeholder
              disappears at the first character. */}
          <div className="mt-1.5 px-1">
            <label
              htmlFor={`saved-search-description-${scope}`}
              className="block text-[0.68rem] text-ink-3"
            >
              Description (optional)
            </label>
            <input
              id={`saved-search-description-${scope}`}
              type="text"
              value={description}
              maxLength={MAX_DESCRIPTION_LENGTH}
              className="mt-1 h-7 w-full rounded-md border border-input bg-surface px-2 text-[0.76rem] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          {signedIn ? (
            /* The choice is the point of the requirement row: a personal
               search, or a team one. Both words are on screen, so nobody
               shares a search by forgetting a field. */
            <fieldset className="mt-1.5 flex items-center gap-3 px-1">
              <legend className="float-left mr-2 text-[0.68rem] text-ink-3">Who sees it</legend>
              {(
                [
                  ["personal", "Personal", "Personal — only you see it"],
                  ["team", "Team", "Team — everybody here sees it"],
                ] as const
              ).map(([value, label, description]) => (
                <label
                  key={value}
                  className="flex items-center gap-1 text-[0.72rem] font-semibold text-ink-2"
                >
                  <input
                    type="radio"
                    name={`saved-search-visibility-${scope}`}
                    value={value}
                    checked={visibility === value}
                    aria-label={description}
                    className="size-3 accent-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                    onChange={() => setVisibility(value)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : null}

          {saveOnServer.isError && (
            <p role="alert" className="mt-1.5 px-1 text-[0.7rem] leading-snug text-red">
              The search did not save. {saveOnServer.error.message}
            </p>
          )}
        </form>

        {count === 0 ? (
          <p className="px-2 py-1.5 text-[0.74rem] text-ink-3">
            No saved search yet. Set the filters you want, then name them above.
          </p>
        ) : (
          <ul className="flex max-h-64 flex-col overflow-y-auto border-t border-line-2 pt-1">
            {rows.map((row) => {
              if (row.origin === "device" && row.id === renamingId) {
                return (
                  <li key={row.key} className="px-1 py-1">
                    <form
                      className="flex items-center gap-1.5"
                      onSubmit={(event) => {
                        event.preventDefault();
                        commitRename(row.id);
                      }}
                    >
                      <input
                        type="text"
                        autoFocus
                        value={renameText}
                        maxLength={60}
                        aria-label={`Rename the saved search ${row.name}`}
                        className="h-7 min-w-0 flex-1 rounded-md border border-input bg-surface px-2 text-[0.76rem] outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
                        onChange={(event) => setRenameText(event.target.value)}
                      />
                      <button
                        type="submit"
                        aria-label={`Save the new name for ${row.name}`}
                        className={ROW_BUTTON}
                      >
                        <Check className="size-3.5" aria-hidden />
                      </button>
                      <button
                        type="button"
                        aria-label={`Keep the name ${row.name}`}
                        className={ROW_BUTTON}
                        onClick={() => setRenamingId(null)}
                      >
                        <X className="size-3.5" aria-hidden />
                      </button>
                    </form>
                  </li>
                );
              }

              if (row.key === confirmKey) {
                /* The confirmation names the search it removes, and it states
                   what the delete costs, because a person must know the cost
                   before the click (FR-DM-091). A team row costs more. */
                return (
                  <li key={row.key} className="rounded-sm bg-surface-2 px-2 py-1.5">
                    <p className="text-[0.72rem] leading-snug text-ink-2">
                      Delete “{row.name}”? {row.cost}
                    </p>
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        type="button"
                        autoFocus
                        aria-label={`Delete the saved search ${row.name}`}
                        className="rounded-md border border-red-border px-2 py-0.5 text-[0.7rem] font-semibold text-red transition-colors hover:bg-red-bg focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
                        onClick={() => remove(row)}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        aria-label={`Keep the saved search ${row.name}`}
                        className="text-[0.7rem] font-semibold text-ink-3 hover:text-ink-2"
                        onClick={() => setConfirmKey(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </li>
                );
              }

              const active = row.query === query;
              const describedBy = `saved-search-row-${scope}-${row.key}`;
              return (
                <li
                  key={row.key}
                  className="flex flex-wrap items-center gap-1 rounded-sm px-1 hover:bg-surface-2"
                >
                  <button
                    type="button"
                    aria-current={active ? "true" : undefined}
                    aria-describedby={row.description === "" ? undefined : describedBy}
                    aria-label={
                      `Apply the saved search ${row.name}, ${row.markPhrase}` +
                      (active ? " — the filters on screen now" : "")
                    }
                    className={cn(
                      "min-w-0 flex-1 truncate rounded-sm px-1 py-1.5 text-left text-[0.78rem] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                      active ? "font-semibold text-primary" : "text-ink",
                    )}
                    onClick={() => apply(row.query)}
                  >
                    {row.name}
                  </button>
                  {/* The mark is a word, never a color alone. A color states
                      nothing to a screen reader and nothing in monochrome. */}
                  <span
                    className={cn(
                      "flex-none rounded-lg px-1.5 py-0.5 text-[0.62rem] font-semibold",
                      row.mark === "Team"
                        ? "bg-accent-soft text-primary"
                        : "bg-surface-2 text-ink-3",
                    )}
                  >
                    {row.mark}
                  </span>
                  {row.canRename && (
                    <button
                      type="button"
                      aria-label={`Rename the saved search ${row.name}`}
                      className={ROW_BUTTON}
                      onClick={() => startRename(row.id, row.name)}
                    >
                      <Pencil className="size-3.5" aria-hidden />
                    </button>
                  )}
                  {row.canDelete && (
                    <button
                      type="button"
                      aria-label={
                        row.origin === "device"
                          ? `Delete the saved search ${row.name} from this device`
                          : `Delete the saved search ${row.name}`
                      }
                      className={ROW_BUTTON}
                      onClick={() => {
                        setRenamingId(null);
                        setConfirmKey(row.key);
                      }}
                    >
                      <Trash2 className="size-3.5" aria-hidden />
                    </button>
                  )}
                  {/* The description reads as a description, never as part of
                      the row's name. `aria-describedby` says it after the
                      accessible name, so the name stays one short phrase. */}
                  {row.description !== "" && (
                    <p
                      id={describedBy}
                      className="w-full px-1 pb-1 text-[0.7rem] leading-snug text-ink-3"
                    >
                      {row.description}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {signedIn && server.isError && (
          <p role="alert" className="mt-1 px-2 pt-1.5 text-[0.68rem] leading-snug text-red">
            The shared list did not load. The searches on this device are still here.
          </p>
        )}

        <p className="mt-1 border-t border-line-2 px-2 pt-1.5 text-[0.68rem] leading-snug text-ink-3">
          {signedIn
            ? "A personal search follows your Quix account. A team search reaches everybody here. A row marked “This device” stays in this browser."
            : "You are not signed in to the Quix Portal, so a saved search stays on this device. Nobody else sees it."}
          {!persists && " This browser blocks storage, so the list ends with the tab."}
        </p>
      </PopoverContent>
    </Popover>
  );
}

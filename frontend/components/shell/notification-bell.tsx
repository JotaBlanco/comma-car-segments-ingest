"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Bell } from "lucide-react";
import Link from "next/link";
import { useState, useSyncExternalStore, type UIEvent } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { journalApi } from "@/lib/api/journal";
import { formatArrival } from "@/lib/format";
import { keys } from "@/lib/hooks/keys";
import { useAnnounce } from "@/lib/hooks/use-announce";
import { journalEntityHref } from "@/lib/journal-href";
import type { JournalEntry, JournalListFilters } from "@/types";

/**
 * In-app notifications - the topbar bell (FR-DM-085).
 *
 * The journal already records every system event and every user action, and
 * `GET /journal` already serves it newest-first and paged
 * (`api/api/routers/journal.py` `list_journal`). So the bell adds no route
 * and no store. It reads that one journal page by page through an infinite
 * query, shows the history in one scrolling panel, and links each entry to
 * its entity through the same map the Audit table reads.
 *
 * ## The badge is a watermark, and nothing is ever hidden
 *
 * The badge counts the entries newer than the last time this viewer opened
 * the panel. Opening the panel moves that mark, so the count falls to zero
 * on its own - no button, no ceremony. The mark is device-local and goes to
 * no server: there is no notification entity in the backend, no collection
 * stores a read flag, and every viewer of a workspace reads the same rows.
 *
 * The list itself never hides and never deletes. The journal is append-only,
 * and an audit feed exists so a person can see what happened - the useful
 * question is what is NEW, not how to erase the rest. Entries newer than the
 * mark carry a small dot and the word "New" for a screen reader; older
 * entries simply stop counting toward the badge.
 *
 * The Audit screen still exists for a reason: it filters by entity, actor,
 * field, kind and time, and it is the permanent record. The bell is the
 * glance; Audit is the ledger.
 *
 * **This is in-app notification only.** No e-mail, no Slack, no per-user
 * routing and no delivery guarantee. A person who never opens the panel is
 * never told twice.
 *
 * ## It fails closed and silent
 *
 * This control sits on every screen, so a fault in it is a fault in every
 * frame. When a journal call fails, times out, or answers a shape this code
 * does not know, the bell shows **no badge and no error**: no error card, no
 * toast, no red state. `data` stays undefined, the entry readers answer the
 * empty list, the count is zero and the panel shows no rows. A bell that
 * shouts about its own failure is worse than no bell.
 *
 * Every read below is defensive for the same reason, and that includes every
 * further page. Nothing here may throw during render, because a throw would
 * take the whole topbar with it.
 *
 * ## The gate and the rhythm
 *
 * `QueryProvider` holds every query until the Portal token resolves
 * (`components/providers/query-provider.tsx`). The gate is React Query's own
 * `IsRestoringProvider`, so this infinite query sits under it like the other
 * thirty, and it sends no request before the phase settles.
 *
 * The poll matches `useHomeSummary` at 10 s and it never goes faster. A poll
 * on an infinite query refetches every loaded page, so a deep scroll costs
 * more per tick - the panel is a glance, so the loaded pages stay few in
 * practice.
 */

/**
 * One page of the bell's read. `page_size` must come from the route's
 * allow-list (10, 20, 50, 100, 200, 500). One hundred funds a real badge
 * count up to 99 - with twenty loaded, the badge could only say "20+",
 * because the count never states a number the loaded slice cannot prove.
 * The cost: the first page of the 10 s poll carries 100 entries instead of
 * 20. It is still one request, and the scroll fetches the next page only
 * when a person asks for it.
 */
const BELL_FILTERS: JournalListFilters = { page: 1, page_size: 100 };

/** The empty answer. A stable reference, so no render loops on a new array. */
const NO_ENTRIES: readonly JournalEntry[] = [];

/* --- The last-seen time ---------------------------------------------------
 *
 * Epoch ms at the moment the viewer last opened the panel. It is device-local
 * state, exactly like the favourites star, so it copies that store whole
 * (`lib/favourites.ts`): a module store over `localStorage`, read through
 * `useSyncExternalStore`, with the empty value as the server snapshot so the
 * first client render matches the server markup. A refused or full
 * `localStorage` never throws - the value falls back to an in-memory copy for
 * this tab, and the bell keeps working.
 */

export const NOTIFICATIONS_SEEN_KEY = "tm-notifications-seen";
export const NOTIFICATIONS_SEEN_VERSION = 1;

/** Nobody ever looked. Every entry then counts as new. */
const NEVER = 0;

/** Snapshot cache - `useSyncExternalStore` needs a stable reference. */
let snapshot: number | undefined;
/** The copy that answers reads when `localStorage` refuses the write. */
let memory = NEVER;
/** True when the last write failed. Reads then come from `memory`. */
let volatileStore = false;
const listeners = new Set<() => void>();

function readSeen(): number {
  if (typeof window === "undefined") return NEVER;
  if (volatileStore) return memory;
  try {
    const raw = window.localStorage.getItem(NOTIFICATIONS_SEEN_KEY);
    if (raw === null) return NEVER;
    const stored = JSON.parse(raw) as { v: number; at: unknown };
    if (stored.v !== NOTIFICATIONS_SEEN_VERSION) return NEVER;
    return typeof stored.at === "number" && Number.isFinite(stored.at) ? stored.at : NEVER;
  } catch {
    // Corrupt JSON, an older version, or a blocked read. Fall back, never throw.
    return memory;
  }
}

function commitSeen(at: number): void {
  memory = at;
  snapshot = at;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        NOTIFICATIONS_SEEN_KEY,
        JSON.stringify({ v: NOTIFICATIONS_SEEN_VERSION, at }),
      );
      volatileStore = false;
    } catch {
      // Quota or privacy mode. The mark lives in memory for this tab only.
      volatileStore = true;
    }
  }
  for (const listener of listeners) listener();
}

/**
 * A second tab wrote the same key. Drop the cache before the listeners run:
 * React re-reads on the notification, and a cache that still holds the old
 * mark answers with the same value, so React renders nothing new.
 */
function onStorage(event: StorageEvent): void {
  // `key` is null when a tab cleared the whole store.
  if (event.key !== null && event.key !== NOTIFICATIONS_SEEN_KEY) return;
  snapshot = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  // One window listener serves every reader, so one event drops the cache one
  // time and every reader then reads the same new mark.
  if (listeners.size === 0 && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

function getSnapshot(): number {
  if (snapshot !== undefined) return snapshot;
  snapshot = readSeen();
  return snapshot;
}

/** The server holds no `localStorage`, so it renders the never-looked value. */
const serverSnapshot = (): number => NEVER;

/** Test seam - drops the caches so a cleared `localStorage` is re-read. */
export function resetNotificationsSeenCache(): void {
  snapshot = undefined;
  memory = NEVER;
  volatileStore = false;
}

/* --- Reading the answer -------------------------------------------------- */

/** The entry's moment in epoch ms, or 0 when the stamp is missing or bad. */
function entryTime(entry: JournalEntry): number {
  const at = Date.parse(String(entry.at));
  return Number.isFinite(at) ? at : 0;
}

/**
 * The entries of one page this code can render, and nothing else.
 *
 * A page of the wrong shape reads as the empty list. That is the silent
 * failure the bell promises: no badge, no error and no throw.
 */
function entriesOf(data: unknown): readonly JournalEntry[] {
  const items = (data as { items?: unknown } | undefined)?.items;
  if (!Array.isArray(items)) return NO_ENTRIES;
  return items.filter(
    (item): item is JournalEntry =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as JournalEntry).id === "string" &&
      typeof (item as JournalEntry).entity_id === "string",
  );
}

/**
 * Every entry across every loaded page, oldest page last, each id once.
 * The journal grows between fetches, so an entry can slide across a page
 * boundary and arrive twice - the second copy is dropped, because duplicate
 * ids would collide as React keys.
 */
function entriesOfPages(data: unknown): readonly JournalEntry[] {
  const pages = (data as { pages?: unknown } | undefined)?.pages;
  if (!Array.isArray(pages)) return NO_ENTRIES;
  const out: JournalEntry[] = [];
  const ids = new Set<string>();
  for (const page of pages) {
    for (const entry of entriesOf(page)) {
      if (ids.has(entry.id)) continue;
      ids.add(entry.id);
      out.push(entry);
    }
  }
  return out;
}

/**
 * The number of the page after this one, or undefined at the end. A page of
 * the wrong shape reads as the last page - the bell then simply offers no
 * more, which is the silent failure it promises.
 */
function nextPageOf(lastPage: unknown): number | undefined {
  const page = Number((lastPage as { page?: unknown } | undefined)?.page);
  const totalPages = Number((lastPage as { total_pages?: unknown } | undefined)?.total_pages);
  if (!Number.isFinite(page) || !Number.isFinite(totalPages)) return undefined;
  return page >= 1 && page < totalPages ? page + 1 : undefined;
}

/** The one line an entry prints under its id. */
function summaryOf(entry: JournalEntry): string {
  if (typeof entry.note === "string" && entry.note.length > 0) return entry.note;
  if (entry.kind === "change" && typeof entry.field === "string") {
    return `${entry.field}: ${entry.old ?? "(empty)"} -> ${entry.new ?? "(empty)"}`;
  }
  if (typeof entry.field === "string" && entry.field.length > 0) return entry.field;
  return typeof entry.actor === "string" ? entry.actor : "";
}

/**
 * Record that the viewer looked, right now.
 *
 * Opening the panel is the act of looking, so it clears the count. The mark
 * goes past the newest entry as well as past now, so a server clock that runs
 * ahead of this browser can never leave a row counted for ever.
 *
 * It sits outside the component because it reads the clock, and the clock is
 * impure. The favourites store stamps `Date.now()` the same way.
 */
function markSeen(entries: readonly JournalEntry[]): void {
  const newest = entries.reduce((latest, entry) => Math.max(latest, entryTime(entry)), 0);
  commitSeen(Math.max(Date.now(), newest));
}

export function NotificationBell() {
  const seen = useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
  const [open, setOpen] = useState(false);
  /* The seen mark as it stood when the panel opened. Opening moves the live
     mark at once, so the "new" dots compare against this frozen copy - they
     must not vanish in the same instant the person looks. */
  const [openedAt, setOpenedAt] = useState(NEVER);
  const announce = useAnnounce();

  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: keys.journal.bell,
    queryFn: ({ pageParam }) => journalApi.list({ ...BELL_FILTERS, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: nextPageOf,
    // Home reads every 10 s and the watcher writes every 30 s. Never faster.
    refetchInterval: 10_000,
  });

  const entries = entriesOfPages(data);
  const unread = entries.filter((entry) => entryTime(entry) > seen).length;

  /* The loaded slice may end before the unread entries do. The badge carries
     a "+" then, because a bell must never state a number it cannot know. */
  const firstPage: unknown = data?.pages?.[0];
  const total = Number((firstPage as { total?: unknown } | undefined)?.total);
  const capped = unread > 0 && unread === entries.length && Number.isFinite(total) && total > unread;
  /* The display stops at "99+". Above that an exact number stops helping, and
     a three-digit badge outgrows the dot. "99+" is always true there: the
     loaded slice itself proves more than 99. */
  const badge = unread > 99 ? "99+" : capped ? `${unread}+` : String(unread);
  const label =
    unread === 0
      ? "Notifications - nothing new"
      : `Notifications - ${badge} new ${unread === 1 && !capped ? "entry" : "entries"}`;

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (next) {
      setOpenedAt(seen);
      markSeen(entries);
      // The badge falls to zero silently otherwise. One polite sentence
      // through the app's single live region tells a screen reader why.
      if (unread > 0) {
        announce(
          unread === 1 && !capped
            ? "1 new entry marked as seen."
            : `${badge} new entries marked as seen.`,
        );
      }
    }
  }

  /** Ask for the next page once. Guarded, so a scroll storm cannot stack. */
  function loadMore(): void {
    if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
  }

  /** Near the bottom, fetch ahead - the button stays as the explicit path. */
  function handleScroll(event: UIEvent<HTMLDivElement>): void {
    const el = event.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 96) loadMore();
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={label}
        title={label}
        className="relative grid size-7 place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors hover:border-line-strong hover:text-ink"
      >
        <Bell size={14} strokeWidth={2} aria-hidden />
        {unread > 0 && (
          <span
            aria-hidden
            className="absolute -top-1.5 -right-1.5 grid min-w-4 place-items-center rounded-full bg-accent-fill px-1 text-[0.6rem] leading-4 font-bold text-accent-ink"
          >
            {badge}
          </span>
        )}
      </PopoverTrigger>
      {/* Escape shuts the panel and returns focus to the bell. Base UI's
          popover owns both, so no key handler of ours can get them wrong. */}
      <PopoverContent align="end" sideOffset={8} className="w-96 gap-0 p-0">
        <div className="border-b border-line px-3 py-2 text-[0.72rem] font-semibold tracking-[0.04em] text-ink-3 uppercase">
          Recent activity
        </div>
        {entries.length === 0 ? (
          /* The empty state and the failed state read the same on purpose. */
          <p className="px-3 py-4 text-[0.8rem] text-ink-3">No activity yet.</p>
        ) : (
          <>
            {/* One block link per entry: the id and the moment on the first
                line, what happened on the second. Both lines truncate with
                the full value on `title`, so a long id can never wrap and
                the nowrap timestamp can never be starved of width. The
                region scrolls, so the popover can never outgrow the frame. */}
            <div className="max-h-96 overflow-y-auto" onScroll={handleScroll}>
              <ul className="m-0 list-none p-0">
                {entries.map((entry) => {
                  const href = journalEntityHref(entry);
                  const at = entryTime(entry);
                  const summary = summaryOf(entry);
                  const isNew = at > openedAt;
                  const body = (
                    <>
                      <span className="flex items-baseline gap-3">
                        <span
                          title={entry.entity_id}
                          className="min-w-0 flex-1 truncate font-mono text-[0.75rem] text-ink"
                        >
                          {entry.entity_id}
                        </span>
                        <span className="shrink-0 text-[0.68rem] whitespace-nowrap text-ink-3 tabular-nums">
                          {at > 0 ? formatArrival(entry.at) : "-"}
                        </span>
                        {isNew && (
                          /* Since the last look. A dot for the eye, a word
                             for the screen reader - never colour alone. */
                          <span className="shrink-0 self-center" title="New since your last look">
                            <span aria-hidden className="block size-1.5 rounded-full bg-accent-fill" />
                            <span className="sr-only">New</span>
                          </span>
                        )}
                      </span>
                      {summary.length > 0 && (
                        <span
                          title={summary}
                          className="mt-0.5 block truncate text-[0.72rem] text-ink-3"
                        >
                          {summary}
                        </span>
                      )}
                    </>
                  );
                  if (href === null) {
                    return (
                      <li key={entry.id} className="border-b border-line-2 px-3 py-2 last:border-0">
                        {body}
                      </li>
                    );
                  }
                  return (
                    <li key={entry.id} className="border-b border-line-2 last:border-0">
                      {/* A click leaves for the entity, so the panel shuts. */}
                      <Link
                        href={href}
                        onClick={() => setOpen(false)}
                        className="block px-3 py-2 no-underline outline-none hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                      >
                        {body}
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {hasNextPage ? (
                /* The keyboard path to the next page. The scroll handler is
                   only the shortcut. The label turns into the loading state
                   in place, so focus never falls off a vanished button. */
                <button
                  type="button"
                  onClick={loadMore}
                  aria-disabled={isFetchingNextPage || undefined}
                  className="block w-full border-t border-line-2 px-3 py-2 text-center text-[0.72rem] font-medium text-primary outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                >
                  {isFetchingNextPage ? "Loading older activity..." : "Show older activity"}
                </button>
              ) : (
                <p className="border-t border-line-2 px-3 py-2 text-center text-[0.68rem] text-ink-3">
                  End of the journal.
                </p>
              )}
            </div>
            <p className="border-t border-line px-3 py-1.5 text-right text-[0.68rem]">
              {/* `text-primary` is the accent, the link tone the rest of the
                  app uses. `text-accent` is the shadcn hover wash, a 13%
                  blue that reads 1.23:1 on the dark panel and 1.13:1 on the
                  light one. The accent holds 6.34:1 dark and 9.55:1 light.
                  The underline stays on, so colour is never the only mark
                  that says this text is a link. */}
              <Link
                href="/audit"
                onClick={() => setOpen(false)}
                className="rounded-sm text-primary underline decoration-1 underline-offset-[3px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Filter the journal in Audit
              </Link>
            </p>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

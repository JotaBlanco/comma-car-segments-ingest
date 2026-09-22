"use client";

import { EmptyState } from "@/components/shared/empty-state";
import { Panel, PanelHead } from "@/components/shared/panel";
import { RowLink, RowLinkLabel } from "@/components/shared/row-link";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SAVED_SEARCH_SCOPE, useMergedSavedSearches } from "@/lib/hooks/use-saved-searches";

/**
 * The Home saved-searches panel (FR-DM-017).
 *
 * It sits under Favorites in the wide left column and copies its shell whole:
 * the same `Panel`, the same heading with a count on the right, the same
 * `RowLink` row, the same `EmptyState`. Only the columns differ, because a
 * saved search names a screen where a favorite names a type.
 *
 * The list itself comes from `useMergedSavedSearches`, the one hook the topbar
 * menu also reads. So the device rows and the server rows merge by one rule in
 * one place, and this panel adds no second rule.
 *
 * The panel is on screen the moment Home loads, so it passes no gate and the
 * four server reads go out with the page. They share their query keys with the
 * topbar menu and with each list screen's toolbar button, so the second reader
 * on any screen costs no second request. A signed-out person sends none of the
 * four, and still reads every row on this device.
 */

/**
 * How many rows the panel prints. The device store caps at 30 per screen and
 * the server serves 50, so the merged list can outgrow the fold. The line
 * below the table says what it holds back, so nothing hides in silence.
 */
const MAX_ROWS = 6;

export function SavedSearchesPanel() {
  const { rows, serverFailed } = useMergedSavedSearches();
  const hidden = rows.length - MAX_ROWS;

  return (
    <Panel>
      <PanelHead
        title="Saved searches"
        action={
          <span className="text-[0.72rem] text-ink-3">
            {rows.length > 0
              ? hidden > 0
                ? `${MAX_ROWS} of ${rows.length}`
                : `${rows.length} saved`
              : "Device and team"}
          </span>
        }
      />
      <Table aria-label="Saved searches">
        <TableHeader>
          <TableRow>
            <TableHead>Search</TableHead>
            <TableHead>Table</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 && (
            <TableRow className="hover:bg-transparent">
              {/* `TableCell` carries `whitespace-nowrap`, and the empty-state
                  text inherits it. A sentence that cannot wrap sets the
                  table's min-content width, and the table container then
                  scrolls sideways. `whitespace-normal` lets the sentence
                  wrap, so a person reads all of it at any column width. */}
              <TableCell colSpan={2} className="p-0! whitespace-normal">
                <EmptyState
                  title="No saved search yet"
                  message="Set the filters you want on a list screen, then name them with the Saved searches button there."
                />
              </TableCell>
            </TableRow>
          )}
          {rows.slice(0, MAX_ROWS).map((row) => (
            <RowLink
              key={row.key}
              href={`${SAVED_SEARCH_SCOPE[row.scope].pathname}${row.query}`}
            >
              <TableCell>
                {/* Two screens can hold one name, so the name alone names
                    nobody. The column beside says which screen, and the label
                    puts that screen in the link's own name as well. */}
                <RowLinkLabel label={`${row.name} on ${SAVED_SEARCH_SCOPE[row.scope].label}`}>
                  {row.name}
                </RowLinkLabel>
              </TableCell>
              <TableCell>{SAVED_SEARCH_SCOPE[row.scope].label}</TableCell>
            </RowLink>
          ))}
        </TableBody>
      </Table>
      {hidden > 0 && (
        <div className="border-t border-line-2 px-4 py-2 text-[0.72rem] text-ink-3">
          {hidden} more saved {hidden === 1 ? "search" : "searches"}. Each list screen holds its
          own.
        </div>
      )}
      {/* The same words the toolbar button and the topbar menu already use for
          the same failure. The rows on this device stay on screen. */}
      {serverFailed && (
        <div
          role="alert"
          className="border-t border-line-2 px-4 py-2 text-[0.72rem] leading-snug text-red"
        >
          The shared list did not load. The searches on this device are still here.
        </div>
      )}
    </Panel>
  );
}

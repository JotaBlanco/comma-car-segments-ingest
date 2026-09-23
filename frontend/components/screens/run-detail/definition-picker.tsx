"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxStatus,
} from "@/components/ui/combobox";
import { useTestDefinitions } from "@/lib/hooks";
import type { TestDefinitionListItem } from "@/types";
import { PICKER_SEARCH_DEBOUNCE_MS, useDebouncedQuery } from "./use-debounced-query";

/** One page of picker matches. 200 is the largest page the list route serves,
    and the typed text narrows it server-side through `?q=`, so no mirrored
    definition is out of reach. */
const DEFINITION_PAGE_SIZE = 200;

interface DefinitionPickerProps {
  /**
   * The work order whose definitions are offered. A run's definitions come
   * from its campaign, and the panel resolves their titles from that same
   * mirror, so a definition outside it would render as a nameless row. The
   * empty string offers every mirrored definition — the case of a run that
   * waits for its work order.
   */
  readonly workOrderId: string;
  readonly pending: boolean;
  onPick: (tdId: string) => void;
  onCancel: () => void;
}

/**
 * Pick one test definition to put on the run.
 *
 * The typed text becomes a server-side `?q=` (debounced), the same way the
 * work-order picker in `edit-run-dialog.tsx` searches the whole mirror rather
 * than one page of it.
 */
export function DefinitionPicker({
  workOrderId,
  pending,
  onPick,
  onCancel,
}: DefinitionPickerProps) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState("");
  const debouncedQuery = useDebouncedQuery(query.trim(), PICKER_SEARCH_DEBOUNCE_MS);

  const definitions = useTestDefinitions({
    page_size: DEFINITION_PAGE_SIZE,
    ...(workOrderId.length > 0 ? { work_order: [workOrderId] } : {}),
    ...(debouncedQuery.length > 0 ? { q: debouncedQuery } : {}),
  });
  const items = definitions.data?.items ?? [];

  return (
    <div className="flex items-center gap-2 border-b border-line-2 px-4 py-2.5">
      <div className="min-w-0 flex-1">
        <label htmlFor="run-add-definition" className="sr-only">
          Test definition to add
        </label>
        {/* The server already filters, so the client-side filter is off. */}
        <Combobox
          items={items}
          filter={null}
          itemToStringLabel={(definition: TestDefinitionListItem) => definition.td_id}
          isItemEqualToValue={(a: TestDefinitionListItem, b: TestDefinitionListItem) =>
            a.td_id === b.td_id
          }
          onInputValueChange={(text) => setQuery(text)}
          onValueChange={(definition: TestDefinitionListItem | null) =>
            setPicked(definition?.td_id ?? "")
          }
        >
          <ComboboxInput
            id="run-add-definition"
            placeholder="Type to search the test definitions"
            className="text-[0.8rem]"
          />
          <ComboboxContent>
            <ComboboxStatus>
              {definitions.isFetching ? "Searching the mirror…" : null}
            </ComboboxStatus>
            <ComboboxEmpty>
              {definitions.isError
                ? "The definition list never arrived. Reload the screen."
                : "No mirrored test definition matches."}
            </ComboboxEmpty>
            <ComboboxList>
              {(definition: TestDefinitionListItem) => (
                <ComboboxItem key={definition.td_id} value={definition}>
                  <span className="truncate text-[0.8rem]">
                    <span className="font-mono">{definition.td_id}</span> · {definition.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <Button
        size="sm"
        disabled={picked.length === 0 || pending}
        onClick={() => onPick(picked)}
      >
        {pending ? "Adding…" : "Add"}
      </Button>
      <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

"use client";

import { useQuery } from "@tanstack/react-query";
import { journalApi } from "@/lib/api/journal";
import type { JournalListFilters } from "@/types";
import { keys } from "./keys";

/** The journal across every entity — `GET /journal` (FR-DM-055, NFR-DM-049). */
export function useJournal(filters: JournalListFilters = {}) {
  return useQuery({
    queryKey: keys.journal.list(filters),
    queryFn: () => journalApi.list(filters),
  });
}

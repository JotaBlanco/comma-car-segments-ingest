"use client";

import { useQuery } from "@tanstack/react-query";
import { directLakeApi } from "@/lib/api/lake";
import { sessionColumn } from "@/lib/explore/lake-partitions";
import { lakeTable } from "@/lib/explore/lake-schema";
import { keys } from "./keys";

/**
 * The lake's partition tree, read the way it is drawn: one level per call.
 *
 * Both reads answer from the catalog's index, never from a storage scan, so a
 * level costs a single indexed query whatever its depth. `staleTime` keeps a
 * level already opened out of the network when a dialog reopens — the estate's
 * folders change when a run lands, not between two clicks.
 */

/** The folders under `path` — empty path for the table's first level. */
export function useLakeLevel(path: string, enabled = true) {
  const table = lakeTable();
  return useQuery({
    queryKey: keys.lake.partitions(table, path),
    queryFn: () => directLakeApi.partitions(table, path),
    enabled,
    staleTime: 30_000,
  });
}

/**
 * The sessions under a set of pinned ancestors: the values of the session
 * column (`run_id` here) wherever the tree is standing, newest-sorting left to
 * the caller. One query, at any depth.
 */
export function useLakeSessions(where: Readonly<Record<string, string>>, enabled = true) {
  const table = lakeTable();
  const column = sessionColumn();
  return useQuery({
    queryKey: keys.lake.partitionValues(table, column, { ...where }),
    queryFn: () => directLakeApi.partitionValues(table, column, where),
    enabled,
    staleTime: 30_000,
  });
}

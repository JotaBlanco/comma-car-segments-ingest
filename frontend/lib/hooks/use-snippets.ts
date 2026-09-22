import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { directLakeApi } from "@/lib/api/lake";
import { withState, type SnippetState } from "@/lib/snippets/anomalies";
import type { DataSnippet } from "@/types";
import { lakeTable } from "@/lib/explore/lake-schema";
import { keys } from "./keys";

/** Every data snippet over the physical lake table: the Issues page. */
export function useAllSnippets() {
  const table = lakeTable();
  return useQuery({
    queryKey: keys.lake.snippets(table, ""),
    queryFn: () => directLakeApi.snippets(table, ""),
    staleTime: 30_000,
  });
}

/** The run's data snippets over the physical lake table: the Issues tab and its count. */
export function useRunSnippets(runId: string) {
  const table = lakeTable();
  return useQuery({
    queryKey: keys.lake.snippets(table, runId),
    queryFn: () => directLakeApi.snippets(table, runId),
    staleTime: 30_000,
  });
}

/**
 * Move one issue to another state. Every snippet list is re-read after, so the badge, the
 * quick views and the counts follow the write rather than a guess about it.
 */
export function useSetIssueState() {
  const table = lakeTable();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ snippet, state }: { snippet: DataSnippet; state: SnippetState }) =>
      directLakeApi.setSnippet(table, snippet.id, withState(snippet, state)),
    onSuccess: () => client.invalidateQueries({ queryKey: ["lake", "snippets"] }),
  });
}

/** One snippet's first rows, read when its Data page opens. */
export function useSnippetData(id: number | null, limit: number) {
  const table = lakeTable();
  return useQuery({
    queryKey: keys.lake.snippetData(table, id ?? 0, limit),
    queryFn: () => directLakeApi.snippetData(table, id ?? 0, limit),
    enabled: id !== null,
  });
}

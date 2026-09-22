import { ApiError, viewerHeaders } from "./client";
import type {
  ExploreQueryRequest,
  ExploreQueryResult,
  LakePartitionLevel,
  LakePartitionValues,
  RunSnippetsResult,
  SnippetDataResult,
} from "@/types";

/* The lake path — the only query path the Explore workbench has. This
   client posts to our own `/api/lake/query` route handler, never to
   `/api/proxy` — the FastAPI app is not in this path. The SQL is forwarded
   verbatim; the run scope and the LIMIT both live in the SQL text
   (`WHERE run_id = '…' … LIMIT n`), so the call sends `{sql}` and nothing
   else.

   The call carries the viewer's Portal token, the same header every
   `/api/proxy` call carries. The route handler refuses a caller that states
   none, because it holds the lake credential and the front end is public. */

async function refused(response: Response): Promise<ApiError> {
  let detail = `Request failed with status ${response.status}`;
  let code = "unknown_error";
  let errors: unknown[] = [];
  try {
    const parsed = (await response.json()) as {
      detail?: unknown;
      code?: unknown;
      errors?: unknown;
    };
    if (typeof parsed.detail === "string") detail = parsed.detail;
    if (typeof parsed.code === "string") code = parsed.code;
    if (Array.isArray(parsed.errors)) errors = parsed.errors;
  } catch {
    /* A non-JSON error body keeps the status-derived message. */
  }
  return new ApiError(response.status, detail, code, errors);
}

export const directLakeApi = {
  /**
   * One level of the partition tree — the sessions dialog's left pane, a
   * folder at a time. `path` is empty for the table's first level and
   * `column=value/column=value` below it; the catalog answers each level from
   * its index, so the tree opens lazily however deep the estate goes.
   */
  partitions: async (table: string, path: string): Promise<LakePartitionLevel> => {
    const q = new URLSearchParams({ table, path });
    const response = await fetch(`/api/lake/partitions?${q}`, { headers: viewerHeaders() });
    if (!response.ok) throw await refused(response);
    return (await response.json()) as LakePartitionLevel;
  },
  /**
   * Every value of ONE partition column under a set of pinned ancestors — the
   * sessions themselves, wherever the tree is standing. One indexed catalog
   * query, so a node twelve levels above the session answers as fast as its
   * parent does; walking the tree down to the session level would cost one
   * call per level per branch.
   */
  partitionValues: async (
    table: string,
    column: string,
    where: Readonly<Record<string, string>> = {},
  ): Promise<LakePartitionValues> => {
    const q = new URLSearchParams({ table, column });
    if (Object.keys(where).length > 0) q.set("where", JSON.stringify(where));
    const response = await fetch(`/api/lake/partition-values?${q}`, { headers: viewerHeaders() });
    if (!response.ok) throw await refused(response);
    return (await response.json()) as LakePartitionValues;
  },
  /** The run's data snippets over the physical table (the Issues tab); every run's for "". */
  snippets: async (table: string, runId: string): Promise<RunSnippetsResult> => {
    const q = new URLSearchParams({ table });
    if (runId !== "") q.set("run", runId);
    const response = await fetch(`/api/lake/snippets?${q}`, { headers: viewerHeaders() });
    if (!response.ok) throw await refused(response);
    return (await response.json()) as RunSnippetsResult;
  },
  /** Move one issue between open, resolved and closed: its whole tag list and note. */
  setSnippet: async (
    table: string,
    id: number,
    body: { tags: readonly string[]; markdown: string },
  ): Promise<void> => {
    const response = await fetch(`/api/lake/snippets/${id}`, {
      method: "PUT",
      headers: { ...viewerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ table, tags: body.tags, markdown: body.markdown }),
    });
    if (!response.ok) throw await refused(response);
  },
  /** One snippet's first rows. */
  snippetData: async (table: string, id: number, limit: number): Promise<SnippetDataResult> => {
    const q = new URLSearchParams({ table, limit: String(limit) });
    const response = await fetch(`/api/lake/snippets/${id}/data?${q}`, {
      headers: viewerHeaders(),
    });
    if (!response.ok) throw await refused(response);
    return (await response.json()) as SnippetDataResult;
  },
  query: async (body: ExploreQueryRequest): Promise<ExploreQueryResult> => {
    const response = await fetch("/api/lake/query", {
      method: "POST",
      headers: { ...viewerHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ sql: body.sql }),
    });
    if (!response.ok) {
      let detail = `Request failed with status ${response.status}`;
      let code = "unknown_error";
      let errors: unknown[] = [];
      try {
        const parsed = (await response.json()) as {
          detail?: unknown;
          code?: unknown;
          errors?: unknown;
        };
        if (typeof parsed.detail === "string") detail = parsed.detail;
        if (typeof parsed.code === "string") code = parsed.code;
        if (Array.isArray(parsed.errors)) errors = parsed.errors;
      } catch {
        /* A non-JSON error body keeps the status-derived message. */
      }
      throw new ApiError(response.status, detail, code, errors);
    }
    return (await response.json()) as ExploreQueryResult;
  },
};

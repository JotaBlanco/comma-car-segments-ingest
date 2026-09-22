import { addJournalEvent, getDb, getGlobalJournal } from "@/lib/mock/db";
import { parsePagination } from "@/lib/mock/helpers";
import type { JournalEntityType, JournalKind } from "@/types";
import { readJsonBody, withApi } from "../_lib/http";

/** One query value, or undefined when the caller sent none. */
function param(sp: URLSearchParams, name: string): string | undefined {
  return sp.get(name) ?? undefined;
}

/**
 * The journal across every entity (FR-DM-055) — `GET /journal`, the Audit
 * screen's one read. Every filter is optional and the filters combine with
 * AND. Default page size 50, sorted `at` desc, like every journal read.
 */
export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    return Response.json(
      getGlobalJournal(
        getDb(),
        {
          entity_type: param(sp, "entity_type") as JournalEntityType | undefined,
          entity_id: param(sp, "entity_id"),
          field: param(sp, "field"),
          actor: param(sp, "actor"),
          kind: param(sp, "kind") as JournalKind | undefined,
          since: param(sp, "since"),
          until: param(sp, "until"),
        },
        parsePagination(sp, 50),
      ),
    );
  });
}

/**
 * One journal event on any entity (★) — `POST /journal`, the ingestion
 * watcher's narration route. The caller's `at` is kept: it is the moment the
 * step happened, never the moment of the call. Answers 201.
 */
export async function POST(request: Request): Promise<Response> {
  return withApi(request, async () => {
    const body = await readJsonBody(request);
    return Response.json(addJournalEvent(getDb(), body), { status: 201 });
  });
}

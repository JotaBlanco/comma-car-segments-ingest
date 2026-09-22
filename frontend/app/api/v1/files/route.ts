import {
  FILES_SORT_DEFAULTS,
  FILES_SORT_WHITELIST,
  getDb,
  listFiles,
} from "@/lib/mock/db";
import { parseBool, parseMulti, parsePagination, parseSort } from "@/lib/mock/helpers";
import type { FileLifecycle, FileListFilters, FileStatus, SourceSystem } from "@/types";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const filters: FileListFilters = {
      status: parseMulti(sp, "status") as FileStatus[] | undefined,
      source_system: parseMulti(sp, "source_system") as SourceSystem[] | undefined,
      lifecycle: parseMulti(sp, "lifecycle") as FileLifecycle[] | undefined,
      run: sp.get("run") ?? undefined,
      unlinked: parseBool(sp.get("unlinked")),
      invalid: parseBool(sp.get("invalid")),
      q: sp.get("q") ?? undefined,
    };
    const sort = parseSort(sp, FILES_SORT_WHITELIST, "registered_at", FILES_SORT_DEFAULTS);
    return Response.json(listFiles(getDb(), filters, parsePagination(sp), sort));
  });
}

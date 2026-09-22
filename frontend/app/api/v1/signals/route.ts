import {
  getDb,
  listSignals,
  SIGNALS_SORT_DEFAULTS,
  SIGNALS_SORT_WHITELIST,
} from "@/lib/mock/db";
import {
  parseBool,
  parseMulti,
  parseMultiNumber,
  parsePagination,
  parseSort,
} from "@/lib/mock/helpers";
import type { SignalListFilters, SourceTag } from "@/types";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const filters: SignalListFilters = {
      unit: parseMulti(sp, "unit"),
      missing_unit: parseBool(sp.get("missing_unit")),
      rig: parseMulti(sp, "rig"),
      rate: parseMultiNumber(sp, "rate"),
      dtype: parseMulti(sp, "dtype"),
      source_system: parseMulti(sp, "source_system"),
      source: parseMulti(sp, "source") as SourceTag[] | undefined,
      q: sp.get("q") ?? undefined,
    };
    const sort = parseSort(sp, SIGNALS_SORT_WHITELIST, "last_seen", SIGNALS_SORT_DEFAULTS);
    return Response.json(listSignals(getDb(), filters, parsePagination(sp), sort));
  });
}

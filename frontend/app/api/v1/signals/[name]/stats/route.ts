import { getDb, getSignalRunStats } from "@/lib/mock/db";
import { MockDbError } from "@/lib/mock/errors";
import { parseBool, parsePagination } from "@/lib/mock/helpers";
import type { SignalStatsFilters } from "@/types";
import { decodeParam, withApi } from "../../../_lib/http";

type Context = { params: Promise<{ name: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { name } = await params;
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    const window = sp.get("window") ?? "run";
    if (window !== "run") {
      throw new MockDbError(400, "unsupported_window", `window=${window} is not supported — only window=run`);
    }
    const filters: SignalStatsFilters = {
      definition: sp.get("definition") ?? undefined,
      rig: sp.get("rig") ?? undefined,
      include_invalid: parseBool(sp.get("include_invalid")) ?? false,
    };
    return Response.json(getSignalRunStats(getDb(), decodeParam(name), filters, parsePagination(sp, 50)));
  });
}

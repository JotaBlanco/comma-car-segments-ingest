import { getDb, listWorkOrders } from "@/lib/mock/db";
import { parseMulti, parsePagination, rejectSort } from "@/lib/mock/helpers";
import type { WorkOrderListFilters, WorkOrderStatus } from "@/types";
import { withApi } from "../_lib/http";

export async function GET(request: Request): Promise<Response> {
  return withApi(request, () => {
    const sp = new URL(request.url).searchParams;
    // Light treatment — /work-orders has no sort params (contract §2.3).
    rejectSort(sp);
    const filters: WorkOrderListFilters = {
      status: parseMulti(sp, "status") as WorkOrderStatus[] | undefined,
      project: parseMulti(sp, "project"),
      q: sp.get("q") ?? undefined,
    };
    return Response.json(listWorkOrders(getDb(), filters, parsePagination(sp)));
  });
}

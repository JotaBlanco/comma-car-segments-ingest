import type { SearchResults } from "@/types";
import { api } from "./client";

export const searchApi = {
  query: (q: string, limitPerGroup?: number) =>
    api.get<SearchResults>("/search", { q, limit_per_group: limitPerGroup }),
};

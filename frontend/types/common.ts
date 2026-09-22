export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
  total_pages: number;
}

/**
 * Optional quick-view counts object on the four list responses.
 * Whole-table / filter-independent — the FE renders these next to the
 * segmented-control labels. Absent = the FE degrades to no badge.
 */
export type ViewCounts = Record<string, number>;

export type SortOrder = "asc" | "desc";

export interface ItemsEnvelope<T> {
  items: T[];
  total: number;
}

export interface ApiErrorBody {
  detail: string;
  code: string;
  errors: unknown[];
}

export type PageParams = {
  page?: number;
  page_size?: number;
};

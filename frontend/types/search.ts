export type SearchGroupType =
  | "test_runs"
  | "work_orders"
  | "files"
  | "signals"
  | "test_definitions"
  | "processed_results";

export interface SearchItem {
  id: string;
  sub: string;
  status: string | null;
  nav: Record<string, string>;
}

export interface SearchGroup {
  type: SearchGroupType;
  items: SearchItem[];
}

export interface SearchResults {
  query: string;
  groups: SearchGroup[];
}

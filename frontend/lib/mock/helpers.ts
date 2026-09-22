import type { Paginated } from "@/types";
import { validation } from "./errors";

export const ALLOWED_PAGE_SIZES = [10, 20, 50, 100, 200, 500] as const;

export interface Pagination {
  page: number;
  pageSize: number;
}

export function parsePagination(searchParams: URLSearchParams, defaultSize = 20): Pagination {
  const rawPage = searchParams.get("page");
  const rawSize = searchParams.get("page_size");
  const page = rawPage === null ? 1 : Number(rawPage);
  const pageSize = rawSize === null ? defaultSize : Number(rawSize);
  if (!Number.isInteger(page) || page < 1) {
    throw validation("validation_error", `invalid page: ${rawPage}`, [
      { loc: ["query", "page"], msg: "must be an integer >= 1", type: "value_error" },
    ]);
  }
  if (!Number.isInteger(pageSize) || !ALLOWED_PAGE_SIZES.includes(pageSize as 10 | 20 | 50 | 100 | 200 | 500)) {
    throw validation("validation_error", `invalid page_size: ${rawSize}`, [
      { loc: ["query", "page_size"], msg: "must be one of 10, 20, 50, 100, 200, 500", type: "value_error" },
    ]);
  }
  return { page, pageSize };
}

export function paginate<T>(items: T[], { page, pageSize }: Pagination, totalOverride?: number): Paginated<T> {
  const total = totalOverride ?? items.length;
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    total,
    page,
    page_size: pageSize,
    total_pages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

export function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function searchRegex(q: string): RegExp {
  return new RegExp(escapeRegex(q.trim()), "i");
}

export function parseBool(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  return value === "true" || value === "1";
}

/**
 * Read a repeated query param and return its values as an array, or
 * `undefined` when the key is absent. Mirrors FastAPI's
 * `Annotated[list[...] | None, Query()] = None`.
 */
export function parseMulti(sp: URLSearchParams, key: string): string[] | undefined {
  const values = sp.getAll(key);
  return values.length === 0 ? undefined : values;
}

/**
 * Same as `parseMulti` but coerces each value with `Number`; every value
 * must parse to a finite number or a 422 `validation_error` is raised.
 */
export function parseMultiNumber(sp: URLSearchParams, key: string): number[] | undefined {
  const values = sp.getAll(key);
  if (values.length === 0) return undefined;
  const parsed: number[] = [];
  for (const raw of values) {
    const num = Number(raw);
    if (!Number.isFinite(num)) {
      throw validation("validation_error", `invalid ${key}: ${raw}`, [
        { loc: ["query", key], msg: "must be a number", type: "value_error" },
      ]);
    }
    parsed.push(num);
  }
  return parsed;
}

export type SortOrder = "asc" | "desc";
export interface ParsedSort<K extends string> {
  key: K;
  order: SortOrder;
}

/**
 * Parse `sort` + `order` query params against a per-endpoint whitelist.
 * `defaultDirections` provides the server default direction for each key
 * (used when `order` is absent) — contract §2.3.
 * Unknown `sort` key or `order` value → 422 `validation_error`.
 */
export function parseSort<K extends string>(
  sp: URLSearchParams,
  whitelist: readonly K[],
  defaultKey: K,
  defaultDirections: Readonly<Record<K, SortOrder>>,
): ParsedSort<K> {
  const rawSort = sp.get("sort");
  const rawOrder = sp.get("order");
  const key = (rawSort ?? defaultKey) as K;
  if (rawSort !== null && !whitelist.includes(rawSort as K)) {
    throw validation("validation_error", `invalid sort: ${rawSort}`, [
      {
        loc: ["query", "sort"],
        msg: `must be one of ${whitelist.join(", ")}`,
        type: "value_error",
      },
    ]);
  }
  let order: SortOrder;
  if (rawOrder === null) {
    order = defaultDirections[key];
  } else if (rawOrder === "asc" || rawOrder === "desc") {
    order = rawOrder;
  } else {
    throw validation("validation_error", `invalid order: ${rawOrder}`, [
      { loc: ["query", "order"], msg: "must be one of asc, desc", type: "value_error" },
    ]);
  }
  return { key, order };
}

/**
 * Assert that neither `sort` nor `order` appears in the query string.
 * Used by `/work-orders` (light treatment — no sort params — contract §2.3).
 */
export function rejectSort(sp: URLSearchParams): void {
  const bad = sp.has("sort") ? "sort" : sp.has("order") ? "order" : null;
  if (bad === null) return;
  throw validation("validation_error", `${bad} is not accepted for this endpoint`, [
    { loc: ["query", bad], msg: "not accepted for this endpoint", type: "value_error" },
  ]);
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function newId(prefix: "j" | "f" | "res"): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function delay(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) {
    const mb = bytes / 1024 ** 2;
    return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
  }
  return `${(bytes / 1024).toFixed(1)} KB`;
}

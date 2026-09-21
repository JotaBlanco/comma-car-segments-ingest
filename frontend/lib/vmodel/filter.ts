/**
 * Generic attribute filtering for the V-model explorer - pure, no React.
 *
 * Every field of an item is a filterable attribute. The attribute list is derived
 * from the loaded documents at runtime, so a new backend field appears in the
 * dropdown automatically without a frontend change.
 *
 * Rows are combined with ONE global AND/OR. Nested groups such as (A AND B) OR C
 * are deliberately not supported; the UI states that limitation in words so an OR
 * control never silently applies AND.
 */

export type FilterOperator =
  | "is"
  | "is_not"
  | "contains"
  | "does_not_contain"
  | "is_empty"
  | "is_not_empty"

export const FILTER_OPERATORS: { value: FilterOperator; label: string }[] = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "does_not_contain", label: "does not contain" },
  { value: "is_empty", label: "is empty" },
  { value: "is_not_empty", label: "is not empty" },
]

/** Operators that need no value - the value input is hidden for these. */
export const VALUELESS_OPERATORS: FilterOperator[] = ["is_empty", "is_not_empty"]

export type FilterCombinator = "AND" | "OR"

export interface FilterRow {
  id: string
  attribute: string
  operator: FilterOperator
  value: string
}

export interface FilterState {
  combinator: FilterCombinator
  rows: FilterRow[]
}

export const EMPTY_FILTER: FilterState = { combinator: "AND", rows: [] }

/** Attributes that are noise in a filter dropdown - long hashes and internals. */
const HIDDEN_ATTRIBUTES = new Set(["canonical_sha256", "schema_version"])

export type FilterableItem = Record<string, unknown>

/**
 * Union of keys across the loaded items, sorted, minus internal noise.
 * Derived from the data - never hardcoded.
 */
export function deriveAttributes(items: FilterableItem[]): string[] {
  const keys = new Set<string>()
  for (const item of items) {
    for (const key of Object.keys(item)) {
      if (!HIDDEN_ATTRIBUTES.has(key)) {
        keys.add(key)
      }
    }
  }
  return Array.from(keys).sort((a, b) => a.localeCompare(b))
}

/**
 * Distinct values seen for one attribute, as suggestions for the value input.
 * Arrays contribute each element. Capped so a free-text field cannot flood the UI.
 */
export function deriveAttributeValues(
  items: FilterableItem[],
  attribute: string,
  limit = 50
): string[] {
  const values = new Set<string>()
  for (const item of items) {
    for (const part of toStringParts(item[attribute])) {
      if (part.length > 0 && part.length <= 60) {
        values.add(part)
      }
    }
    if (values.size > limit * 4) break
  }
  return Array.from(values)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit)
}

/** Flatten any field value into the list of strings a filter compares against. */
function toStringParts(value: unknown): string[] {
  if (value === null || value === undefined) return []
  if (Array.isArray(value)) return value.flatMap(toStringParts)
  if (typeof value === "object") {
    // Objects such as `measurand` entries: match on their scalar leaves.
    return Object.values(value as Record<string, unknown>).flatMap(toStringParts)
  }
  return [String(value)]
}

/** True when the field carries no information: null, "", [], {} or all-blank. */
export function isValueEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === "object") return Object.keys(value as object).length === 0
  return String(value).trim() === ""
}

/** A row with no value on a value-taking operator is inactive, not "matches nothing". */
export function isRowActive(row: FilterRow): boolean {
  if (!row.attribute) return false
  if (VALUELESS_OPERATORS.includes(row.operator)) return true
  return row.value.trim() !== ""
}

function matchesRow(item: FilterableItem, row: FilterRow): boolean {
  const raw = item[row.attribute]

  if (row.operator === "is_empty") return isValueEmpty(raw)
  if (row.operator === "is_not_empty") return !isValueEmpty(raw)

  const needle = row.value.trim().toLowerCase()
  const parts = toStringParts(raw).map((part) => part.toLowerCase())

  switch (row.operator) {
    case "is":
      return parts.some((part) => part === needle)
    case "is_not":
      return !parts.some((part) => part === needle)
    case "contains":
      return parts.some((part) => part.includes(needle))
    case "does_not_contain":
      return !parts.some((part) => part.includes(needle))
    default:
      return true
  }
}

/**
 * Apply the whole filter. An empty or fully-inactive filter returns the input
 * untouched, so the default view shows every item across every version.
 */
export function applyFilter<T extends FilterableItem>(
  items: T[],
  state: FilterState
): T[] {
  const active = state.rows.filter(isRowActive)
  if (active.length === 0) return items

  return items.filter((item) =>
    state.combinator === "AND"
      ? active.every((row) => matchesRow(item, row))
      : active.some((row) => matchesRow(item, row))
  )
}

export function isFilterActive(state: FilterState): boolean {
  return state.rows.some(isRowActive)
}

export function newFilterRow(attribute = ""): FilterRow {
  return {
    id: Math.random().toString(36).slice(2, 10),
    attribute,
    operator: "contains",
    value: "",
  }
}

/**
 * Serialise the filter into a URL-safe base64 blob so a filtered view is shareable.
 * Unicode-safe via encodeURIComponent round-tripping.
 */
export function encodeFilter(state: FilterState): string {
  const payload = JSON.stringify({
    c: state.combinator,
    r: state.rows.map((row) => [row.attribute, row.operator, row.value]),
  })
  if (typeof window === "undefined") return ""
  return window.btoa(encodeURIComponent(payload))
}

export function decodeFilter(encoded: string | null): FilterState | null {
  if (!encoded || typeof window === "undefined") return null
  try {
    const parsed = JSON.parse(decodeURIComponent(window.atob(encoded)))
    const combinator: FilterCombinator = parsed?.c === "OR" ? "OR" : "AND"
    const rawRows: unknown = parsed?.r
    if (!Array.isArray(rawRows)) return null

    const rows: FilterRow[] = rawRows
      .filter((entry): entry is unknown[] => Array.isArray(entry) && entry.length >= 3)
      .map((entry) => ({
        id: Math.random().toString(36).slice(2, 10),
        attribute: String(entry[0] ?? ""),
        operator: (FILTER_OPERATORS.some((op) => op.value === entry[1])
          ? entry[1]
          : "contains") as FilterOperator,
        value: String(entry[2] ?? ""),
      }))

    return { combinator, rows }
  } catch {
    return null
  }
}

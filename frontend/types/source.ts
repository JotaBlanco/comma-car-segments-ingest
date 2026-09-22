export type SourceTag = "embedded" | "manual" | `api:${string}`;

export interface FieldSource {
  source: SourceTag;
  actor: string;
  at: string;
}

export type FieldSources = Record<string, FieldSource>;

/** Client-side view-model only — never on the wire. */
export interface Sourced<T> {
  value: T | null;
  /** null source + null value = "awaiting sync" empty state. */
  source: SourceTag | null;
  actor?: string;
  at?: string;
}

export function sourced<
  E extends { field_sources?: FieldSources },
  K extends Extract<keyof E, string>,
>(entity: E, field: K): Sourced<NonNullable<E[K]>> {
  const fieldSource = entity.field_sources?.[field];
  return {
    value: (entity[field] ?? null) as NonNullable<E[K]> | null,
    source: fieldSource?.source ?? null,
    actor: fieldSource?.actor,
    at: fieldSource?.at,
  };
}

/**
 * The tag in plain words, for the badge tooltip and the filter options.
 *
 * A reader who never read the API contract sees only the wire word, so each
 * sentence names the writer. The wire spells the catalogue system the British
 * way; screen text uses the American spelling, which is the repo's rule.
 */
export function sourceMeaning(source: string): string {
  if (source === "embedded") return "Ingestion wrote this value from the measurement file.";
  if (source === "manual") return "A person typed this value into the Test Manager.";
  if (source === "derived") {
    return "The Test Manager computed this value from other records. Nothing stores it and nobody can edit it.";
  }
  const system = source.startsWith("api:") ? source.slice(4) : source;
  return `The ${system === "catalogue" ? "catalog" : system} system wrote this value over the API.`;
}

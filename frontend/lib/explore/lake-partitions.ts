/**
 * Where a SESSION sits in the lake's partition tree, and what lies inside it.
 *
 * The lake writes one hive tree per table and the sink states its order
 * (`lake-sink/app.yaml`, `HIVE_COLUMNS`). For this estate it is
 *
 *     platform / work_order / test_definition / run_id / protocol / bus / stream / fcc / signal
 *     └──────────── a session's address ─────────────┘ └────── inside the session ──────┘
 *
 * Two pickers read that tree and they read DIFFERENT halves of it. The
 * sessions dialog walks the levels down to the run and picks one: that half
 * is the session's ADDRESS. The Explorer roots itself on a picked run and
 * walks what is below: that half is the session's CONTENTS. Nothing in the
 * tree itself says where the cut is — `run_id` is a folder like any other —
 * so the operator states it:
 *
 *     TM_LAKE_SESSION_PARTITIONS=platform,work_order,test_definition,run_id
 *     TM_LAKE_DATA_PARTITIONS=protocol,~bus,~stream,~fcc,~signal
 *
 * The LAST session column is the session itself (`run_id` here): everything
 * before it is a folder the sessions dialog shows in its tree, and everything
 * in the data list is a level the Explorer shows under a picked session. A
 * project with another shape (`site,rig,session` over `channel,signal`) states
 * its own names and both pickers follow, with no code change.
 *
 * A `~` prefix marks a virtual partition in the sink's own variable (indexed
 * for navigation, no directory). The prefix is stripped here, so an operator
 * can paste `HIVE_COLUMNS` verbatim and split it at the session level.
 *
 * **How the value arrives.** Exactly like `TM_LAKE_TABLE`
 * (`lib/explore/lake-schema.ts`): the variables reach the SERVER process only,
 * `app/layout.tsx` reads them at request time and `LakeConfigProvider` hands
 * them to the setter below during render. No `NEXT_PUBLIC_` name exists and
 * `next build` bakes nothing into the image.
 */

/** The session address this estate's sink writes — the fallback when unset. */
export const DEFAULT_SESSION_PARTITIONS: readonly string[] = [
  "platform",
  "work_order",
  "test_definition",
  "run_id",
];

/** The levels inside one session — the fallback when unset. */
export const DEFAULT_DATA_PARTITIONS: readonly string[] = [
  "protocol",
  "bus",
  "stream",
  "fcc",
  "signal",
];

/**
 * Read one variable into a column list: comma or slash separated, blanks
 * dropped, a `~` virtual marker and a trailing `=` (a pasted folder name)
 * stripped. An unusable name is dropped rather than carried into a path.
 */
export function parsePartitionColumns(raw: string | null | undefined): string[] {
  return String(raw ?? "")
    .split(/[,/]/)
    .map((part) => part.trim().replace(/^~+/, "").replace(/=+$/, "").trim())
    .filter((name) => name !== "" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
}

/**
 * A parsed list, or this estate's own shape when it is empty.
 *
 * The SERVER reads its own variable (a route handler has no provider above
 * it), so it parses and falls back through this rather than through the
 * module state the provider writes.
 */
export function sessionColumnsOf(parsed: readonly string[]): readonly string[] {
  return parsed.length > 0 ? parsed : DEFAULT_SESSION_PARTITIONS;
}

let configuredSession: readonly string[] | null = null;
let configuredData: readonly string[] | null = null;

/**
 * Take the two variables the server read. An empty or unusable value means
 * "unset", and this estate's own shape applies.
 *
 * Like `setLakeTable`, this runs during `LakeConfigProvider`'s render and
 * writes two module variables, so a child reads them on its own first render
 * and a repeated render costs nothing.
 */
export function setLakePartitions(session: string | null | undefined, data: string | null | undefined): void {
  const s = parsePartitionColumns(session);
  const d = parsePartitionColumns(data);
  configuredSession = s.length > 0 ? s : null;
  configuredData = d.length > 0 ? d : null;
}

/** A session's address, outermost first; the last entry is the session itself. */
export function sessionColumns(): readonly string[] {
  return configuredSession ?? DEFAULT_SESSION_PARTITIONS;
}

/** The partition column that IS the session — `run_id` here. */
export function sessionColumn(): string {
  const columns = sessionColumns();
  return columns[columns.length - 1];
}

/**
 * The folders ABOVE the session: the levels the sessions dialog's tree walks.
 * Empty when the session is the table's first level, and the tree is then the
 * root alone.
 */
export function sessionTreeColumns(): readonly string[] {
  return sessionColumns().slice(0, -1);
}

/** The levels inside one session: what the Explorer's tree shows under a run. */
export function dataColumns(): readonly string[] {
  return configuredData ?? DEFAULT_DATA_PARTITIONS;
}

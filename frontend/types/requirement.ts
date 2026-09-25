import type { PageParams, Paginated } from "./common";
import type { FieldSources, SourceTag } from "./source";

/**
 * The closed EARS sentence-pattern enum (CLAUDE.md's requirements table).
 * Authored, board-mandated — never derived from facets.
 */
export type EarsPattern =
  | "Ubiquitous"
  | "StateDriven"
  | "EventDriven"
  | "OptionalFeature"
  | "UnwantedBehaviour"
  | "Complex";

export const EARS_PATTERNS: readonly EarsPattern[] = [
  "Ubiquitous",
  "StateDriven",
  "EventDriven",
  "OptionalFeature",
  "UnwantedBehaviour",
  "Complex",
];

/**
 * The five-value derived lifecycle this code defines
 * (`dev-planning/requirement-status-from-runs/spec.md` §5.3). Coverage and
 * a verdict are two different facts — `covered` can read 100% with nothing
 * run, which is the board's own point.
 */
export type VerificationState = "not_covered" | "covered" | "exercised" | "failed" | "tested";

export const VERIFICATION_STATES: readonly VerificationState[] = [
  "not_covered",
  "covered",
  "exercised",
  "failed",
  "tested",
];

export interface RequirementMeasurand {
  name: string;
  unit: string;
}

/** One verdict outcome. `error` is not a failure — an evaluator that could
    not decide leaves the requirement `exercised`, never `failed`. */
export type VerdictOutcome = "pass" | "fail" | "error";

/**
 * `GET /requirements` row and `GET /requirements/{req_id}` base — every `D`
 * field is computed server-side by the model spec's one `_project` fold; the
 * browser never recomputes one (contract §10.5).
 *
 * Shaped against the API actually committed
 * (`api/api/models/requirements.py`), not only the spec text: `chapter`,
 * `ears_pattern`, `revision`, `verification_method` are nullable there — an
 * older or partly-pushed mirror row can carry none of them. `asil` does not
 * exist on the committed model at all (`requirements-page/spec.md` proposed
 * it; it was not built) — omitted here rather than typed as a lie.
 *
 * `system_states`, `measurand`, `source`, `related_reqs`, `item_version`,
 * `content_sha256` and `field_sources` are **detail-only** on the committed
 * API — they do not ride the list row. The widened list columns for the
 * first four are therefore an EXTENSION this frontend asks for but the list
 * read does not yet serve; see the architecture doc's "Beyond §10" section
 * for the exact gap and how the screen degrades until it closes.
 */
export interface RequirementRow {
  req_id: string;
  title: string;
  /** The owning subsystem the Test Manager nests under the project. Null on
      every catalog but the battery one; absent from a mirror built before the
      field shipped. */
  system?: string | null;
  chapter: string | null;
  status: string; // authored, customer-configured enum — never colour-mapped
  verification_method: string | null; // authored
  ears_pattern: EarsPattern | null; // authored
  revision: string | null; // authored

  verification_state: VerificationState; // D
  evidence_stale: boolean; // D
  verified_by: string[]; // D — BP5, never stored
  covering_run_ids: string[]; // D — capped at 20 on the list read
  covering_run_count: number; // D — the true total
  latest_run_id: string | null; // D
  tested_at: string | null; // D

  synced_at: string | null;

  /**
   * The widened list columns this page adds that the committed
   * `RequirementRow` does not (yet) carry. Optional and rendered as empty
   * when absent, never as an error — the screen's "Beyond §10" ask, not a
   * lie about what today's list read sends.
   */
  system_states?: string[];
  measurand?: RequirementMeasurand[];
  source?: string[];
  related_reqs?: string[];
}

/**
 * Matched to the committed `RequirementEvidence`
 * (`api/api/models/requirements.py`) — note it carries no `first_data_at`.
 * `requirements-page/spec.md` §7E's "Arrived" column assumed one; this
 * build renders it only when present (an EXTENSION the API would need to
 * add, since a run's arrival time is meaningful evidence context) and falls
 * back to a dash otherwise, never to an "Invalid Date" string.
 */
export interface RequirementEvidence {
  run_id: string;
  definition_id: string;
  definition_title: string;
  first_data_at?: string;
  outcome: VerdictOutcome | null;
  produced_at: string | null;
  implementation_sha256: string | null;
  current: boolean | null;
  evidence_values: Record<string, number>;
}

export interface RequirementDetail extends RequirementRow {
  text: string;
  /** `{parameter}` tokens resolved to `name (value unit)`. Null until the
      seed side of BL-11's parameter substitution lands. */
  text_rendered: string | null;
  /**
   * One entry per `{token}` in `text`, naming what it resolved to — an
   * EXTENSION beyond §10.3's flat `text_rendered` string, needed so the
   * text panel can draw each substitution as its own inline chip (spec
   * §7B) instead of guessing token positions inside the flat string.
   * Absent or empty falls back to `text_rendered` with no per-token chips.
   */
  resolved_tokens?: { token: string; resolved: string }[];
  /** Required (never absent) on the detail read, unlike the row's optional,
      not-yet-served widened columns. */
  measurand: RequirementMeasurand[];
  system_states: string[];
  source: string[];
  related_reqs: string[];
  rationale: string | null;
  verification_criteria: string | null;
  figure_refs: string[];
  normative_sha256: string;
  normative_changed_at: string | null;
  /** Overrides the row's capped array — the detail read is uncapped. */
  covering_run_ids: string[];
  evidence: RequirementEvidence[];

  /** Concurrency guard (authoring-controls §6): `parent_version` on a
      PATCH/retire must equal this or the write is refused `stale_parent`. */
  item_version: number;
  content_sha256: string;
  /**
   * Per-field provenance — the same `FieldSources` shape every other entity
   * detail already carries (`sourced()`, `types/source.ts`). There is no
   * flat "row origin" field on the committed API: whether a row is
   * planning-mirrored or manually authored is read off a field's own
   * source, not a separate tag. `requirementOrigin()` below picks one
   * canonical field (`title`) as the row-level proxy.
   */
  field_sources: FieldSources;
}

/**
 * Where a row's values came from: `title` is authored on every requirement
 * regardless of origin, so its source stands for the row's. It answers
 * "where did this come from", never "may this be edited" — every row is
 * editable, and an edit writes `manual`, which outranks a later planning
 * sync (`api/api/provenance.py`). Absent `field_sources` reads as `null`.
 */
export function requirementOrigin(detail: RequirementDetail): SourceTag | null {
  return detail.field_sources.title?.source ?? null;
}

export interface RequirementViewCounts {
  all: number;
  not_covered: number;
  covered: number;
  exercised: number;
  failed: number;
  tested: number;
  /**
   * `not_covered ∪ covered` — the `no-evidence` quick view's count. Optional:
   * the committed `RequirementViewCounts` (`api/api/models/requirements.py`)
   * does not carry this field yet. Absent, the quick view still filters
   * correctly (it sends `state=not_covered&state=covered`); it just shows no
   * count badge until the fold adds it.
   */
  no_evidence?: number;
}

export interface RequirementPage extends Paginated<RequirementRow> {
  /** Optional: an API built before the fold sends no field. */
  view_counts?: RequirementViewCounts;
}

/**
 * `GET /requirements/facets` — distinct values over the WHOLE mirror, sorted
 * ascending (contract §10.2). `ears_pattern` is not here: its six values are
 * a closed board enum this code already defines (`EARS_PATTERNS`), so a
 * facet round trip on it would be wasted, exactly as `verification_state`
 * is excluded for the same reason.
 */
export interface RequirementFacets {
  chapters: string[];
  statuses: string[];
  methods: string[];
  system_states: string[];
  measurands: string[];
  sources: string[];
}

/**
 * `GET /requirements` query. `chapter` / `status` / `state` / `method` / `q`
 * are contract §10.1/§11 as written. Every other key is an EXTENSION this
 * page's widened, filterable column set needs and that the read contract
 * does not (yet) define — see the architecture doc's "Beyond §10" section.
 * An API that does not implement one yet simply ignores it: no param here
 * changes the shape of a response it is missing from.
 */
export type RequirementListFilters = PageParams & {
  q?: string;
  chapter?: readonly string[];
  status?: readonly string[];
  state?: readonly VerificationState[];
  method?: readonly string[];
  ears_pattern?: readonly EarsPattern[];
  system_state?: readonly string[];
  measurand?: readonly string[];
  source?: readonly string[];
  revision?: string;
  related_req?: string;
  has_verified_by?: boolean;
  has_latest_run?: boolean;
};

/**
 * The authored fields `POST /requirements` accepts, matched field-for-field
 * to the committed `RequirementCreateRequest` (`api/api/models/requirements.py`).
 * `RequestModel` sets `extra="forbid"`, so a key this interface does not name
 * — `asil`, `status` on the patch body below — 422s the whole request; this
 * shape is deliberately exact, not "the fields I'd like to send."
 */
export interface RequirementCreateBody {
  id: string;
  title: string;
  text: string;
  ears_pattern: EarsPattern;
  chapter?: string;
  system_states?: string[];
  rationale?: string;
  source?: string[];
  verification_method?: string;
  measurand?: RequirementMeasurand[];
  revision?: string;
  related_reqs?: string[];
  figure_refs?: string[];
  verification_criteria?: string | null;
  /** Restricted to `NEW`/`Draft` server-side; defaults to `Draft`. */
  status?: "NEW" | "Draft";
  actor: string;
  note?: string;
}

/**
 * `PATCH /requirements/{req_id}` — a requirement's authored fields, a subset,
 * `item_version`-guarded (authoring-controls §6, §9). `status` rides along and
 * is gated server-side by the transition table (requirement-status-gates
 * §4.1): only the free band — `Draft`, `Ready for Review`, `Rejected` — is
 * reachable from here, and only from a status the table allows. `In Review`
 * and `Reviewed` are written by the review flow; `Implemented` and `Tested`
 * are never stored at all, they are read off `verification_state`. Anything
 * else answers 409 `illegal_transition`.
 *
 * No `asil`: it was proposed by `requirements-page/spec.md` and never built.
 */
export interface RequirementPatchBody {
  parent_version: number;
  actor: string;
  /** Required once `status` reads `Reviewed` on the row being edited (§7).
      The server records it on the note of every journal entry the edit
      produces; it is not stored as a field. */
  second_actor?: string;
  note?: string;
  /** Moved by the detail screen's status control, never by the edit dialog. */
  status?: string;
  title?: string;
  text?: string;
  chapter?: string;
  ears_pattern?: EarsPattern;
  system_states?: string[];
  rationale?: string;
  source?: string[];
  verification_method?: string;
  measurand?: RequirementMeasurand[];
  revision?: string;
  figure_refs?: string[];
  related_reqs?: string[];
  verification_criteria?: string | null;
}

/** `POST /requirements/{req_id}/retire` — retire means `status: Obsolete`,
    row and id kept, never delete (authoring-controls §5). */
export interface RequirementRetireBody {
  parent_version: number;
  actor: string;
  successor_id?: string;
  note?: string;
}

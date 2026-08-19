/**
 * Project-level constants for the V-model explorer.
 *
 * The requirement schema carries no per-item project or feature field: the whole
 * register is the ACC feature of the QuixPlatformVehicle project. These two fixed
 * tree levels live here and are never inlined in a view.
 */

export const VMODEL_PROJECT = "QuixPlatformVehicle"
export const VMODEL_FEATURE = "ACC"

/** Requirement chapters, in the order they should appear in the tree. */
export const VMODEL_CHAPTERS = [
  "Performance",
  "Safety-Fault-Handling",
  "Functional-HMI",
] as const

/**
 * Requirement-id discipline segment -> chapter. `ACC-SYS-PRF-020` -> `Performance`.
 *
 * A test case carries no chapter of its own, so the Test Specification tree
 * derives one from `covers_req_ids[0]`. Verified 1:1 against all 37 requirements
 * in the register: FUN -> Functional-HMI, PRF -> Performance, SAF -> Safety-Fault-Handling.
 */
export const REQ_SEGMENT_CHAPTERS: Record<string, string> = {
  PRF: "Performance",
  SAF: "Safety-Fault-Handling",
  FUN: "Functional-HMI",
}

/**
 * The verification tag the brief calls the single most important qualifier on a
 * requirement in this register. Rendered amber wherever it appears.
 */
export const UNVERIFIED_TAG = "UNVERIFIED-2018"

/**
 * Base path of the V-model read API. Every V-model API module composes its paths
 * from this constant so a backend prefix change is a one-line edit.
 * `apiGet` already prefixes `/api/v1`.
 */
export const VMODEL_API_BASE = "/vmodel"

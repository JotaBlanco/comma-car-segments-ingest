/**
 * Pure helpers for the Test Specification stage - no React, no DOM.
 *
 * The one thing this module exists for: a test case links to requirements by
 * BARE id (`ACC-SYS-FUN-005`), while a requirement's own key carries its artifact
 * version (`ACC-SYS-FUN-005@v0001`). Every cross-stage deep link has to bridge
 * that mismatch, so the resolution lives here once instead of in each component.
 */

import { REQ_SEGMENT_CHAPTERS } from "./constants"
import type { Requirement, TestSpec } from "@/types/vmodel"

/** Group value used when a test case covers nothing we can place in a chapter. */
export const UNMAPPED_CHAPTER = "Unmapped"

/**
 * Chapter of a bare requirement id, read from its discipline segment:
 * `ACC-SYS-PRF-020` -> `Performance`. Returns null for an unrecognised shape.
 */
export function chapterForReqId(reqId: string | undefined): string | null {
  if (!reqId) return null
  const segment = reqId.split("-")[2]
  return (segment && REQ_SEGMENT_CHAPTERS[segment]) ?? null
}

/**
 * Add the derived `chapter` field the tree groups by.
 *
 * A test case carries no chapter of its own; it inherits the chapter of the
 * first requirement it covers. Writing it onto the item (rather than passing a
 * function into the tree builder) also makes it an ordinary filter attribute,
 * which is the standing rule for this feature: everything is an attribute.
 */
export function withDerivedChapter(specs: TestSpec[]): TestSpec[] {
  return specs.map((spec) => ({
    ...spec,
    chapter: chapterForReqId(spec.covers_req_ids?.[0]) ?? UNMAPPED_CHAPTER,
  }))
}

/**
 * Bare requirement id -> the artifact version to link to.
 *
 * Versions are zero-padded (`v0001`, `v0002`, ...), so the highest string is the
 * current one. Requirements whose register did not load are simply absent, and
 * the caller renders them as plain text rather than a link that goes nowhere.
 */
export function buildRequirementVersionIndex(
  requirements: Requirement[]
): Map<string, string> {
  const index = new Map<string, string>()
  for (const requirement of requirements) {
    const current = index.get(requirement.req_id)
    if (!current || requirement.artifact_version > current) {
      index.set(requirement.req_id, requirement.artifact_version)
    }
  }
  return index
}

/** Bare requirement id -> its title, for link labels. */
export function buildRequirementTitleIndex(
  requirements: Requirement[]
): Map<string, string> {
  const index = new Map<string, string>()
  for (const requirement of requirements) {
    if (!index.has(requirement.req_id)) {
      index.set(requirement.req_id, requirement.title)
    }
  }
  return index
}

/**
 * The versioned requirement key for a bare id, or null when the register does
 * not know it. Null means "render the id, do not fabricate a link".
 */
export function requirementKeyFor(
  reqId: string,
  versionIndex: Map<string, string>
): string | null {
  const version = versionIndex.get(reqId)
  return version ? `${reqId}@${version}` : null
}

/** Deep link into the Requirements explorer for an already-resolved key. */
export function requirementHref(key: string): string {
  return `/requirements?select=${encodeURIComponent(key)}`
}

/** Deep link into the Test Specification explorer. */
export function testSpecHref(key: string): string {
  return `/test-specs?select=${encodeURIComponent(key)}`
}

/**
 * Reverse index: bare requirement id -> the test specs that cover it.
 *
 * Built client-side from the 9 loaded specs. The forward link
 * (`covers_req_ids[]`) is the authoritative one; this is its mirror, and it is
 * what lets the Requirements page answer "what verifies this?" without a second
 * endpoint. `Requirement.verified_by[]` is NOT the source - it is empty on every
 * requirement until the test phase.
 */
export function buildCoveringSpecIndex(specs: TestSpec[]): Map<string, TestSpec[]> {
  const index = new Map<string, TestSpec[]>()
  for (const spec of specs) {
    for (const reqId of spec.covers_req_ids ?? []) {
      const bucket = index.get(reqId)
      if (bucket) {
        bucket.push(spec)
      } else {
        index.set(reqId, [spec])
      }
    }
  }
  return index
}

/**
 * Specs covering one requirement. Accepts either a bare id or a versioned key
 * so callers can pass `requirement.key` straight through.
 */
export function coveringSpecsFor(
  index: Map<string, TestSpec[]>,
  reqIdOrKey: string | null | undefined
): TestSpec[] {
  if (!reqIdOrKey) return []
  return index.get(reqIdOrKey.split("@")[0]) ?? []
}

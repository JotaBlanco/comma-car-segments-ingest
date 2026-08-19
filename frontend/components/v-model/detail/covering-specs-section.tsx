"use client"

import Link from "next/link"
import { DetailSection } from "./detail-section"
import { testSpecHref } from "@/lib/vmodel/test-specs"
import type { TestSpec } from "@/types/vmodel"

interface CoveringSpecsSectionProps {
  /** Specs whose `covers_req_ids[]` names this requirement. */
  specs: TestSpec[]
  /** True while the test specification register is still loading. */
  loading: boolean
  /** True when that register could not be reached at all. */
  unavailable: boolean
}

/**
 * The reverse traceability link: which test specifications verify this
 * requirement.
 *
 * Built client-side by inverting `covers_req_ids[]` across the loaded test specs
 * (`buildCoveringSpecIndex`), not from a coverage endpoint and NOT from
 * `Requirement.verified_by[]` - that field is empty on every requirement until
 * the test phase and is not the coverage source.
 *
 * An empty list renders explicit words. "No covering test case" is a real,
 * important answer on this register; a blank region would read as a bug.
 */
export function CoveringSpecsSection({
  specs,
  loading,
  unavailable,
}: CoveringSpecsSectionProps) {
  return (
    <DetailSection title="Verified by test specifications">
      {loading ? (
        <p className="text-sm text-muted-foreground">
          Loading the test specification register&hellip;
        </p>
      ) : unavailable ? (
        <p className="text-sm text-muted-foreground">
          Unknown &mdash; the test specification register could not be loaded, so coverage
          cannot be shown.
        </p>
      ) : specs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          None &mdash; this requirement has no covering test case.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {specs.map((spec) => (
            <li key={spec.key}>
              <Link
                href={testSpecHref(spec.key)}
                className="inline-flex items-baseline gap-2 rounded-full border px-2.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                <span className="font-mono text-xs">{spec.tc_id}</span>
                <span className="text-xs">{spec.title}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </DetailSection>
  )
}

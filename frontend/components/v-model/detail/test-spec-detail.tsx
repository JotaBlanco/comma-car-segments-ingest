"use client"

import { Badge } from "@/components/ui/badge"
import { DefinitionGrid, DetailSection } from "./detail-section"
import { PassCriteriaTable } from "./pass-criteria-table"
import { RequirementLink } from "./requirement-link"
import type { TestSpec } from "@/types/vmodel"

interface TestSpecDetailProps {
  /** The selected test case, or null when nothing is selected. */
  spec: TestSpec | null
  /** Bare requirement id -> current artifact version, for the links. */
  versionIndex: Map<string, string>
  /** Bare requirement id -> title, for the link labels. */
  titleIndex: Map<string, string>
  /** True while the requirements register is still loading. */
  requirementsLoading: boolean
}

/**
 * Region C for the Test Specification stage.
 *
 * Ordering is deliberate: what the case proves, WHICH REQUIREMENTS IT VERIFIES,
 * then the conditions under which the proof is valid, then the criteria as data.
 * The requirement links are placed directly under the objective because the
 * requirement-to-test link is the reason this page exists.
 */
export function TestSpecDetail({
  spec,
  versionIndex,
  titleIndex,
  requirementsLoading,
}: TestSpecDetailProps) {
  if (!spec) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          Select a test case in the tree to see its objective, the requirements it
          verifies and its pass criteria.
        </p>
      </div>
    )
  }

  const dataRequirements = spec.data_requirements
  const coveredIds = spec.covers_req_ids ?? []

  return (
    <article className="mx-auto max-w-4xl space-y-6 p-6">
      {/* 1. Header */}
      <header className="space-y-3">
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{spec.tc_id}</h1>
        <p className="text-lg leading-snug">{spec.title}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">{spec.status}</Badge>
          <Badge variant="secondary">rev {spec.revision}</Badge>
          <Badge variant="outline" className="font-mono">
            {spec.artifact_version}
          </Badge>
          {spec.mnemonic && (
            <Badge variant="outline" className="font-mono">
              {spec.mnemonic}
            </Badge>
          )}
          {spec.technique && <Badge variant="secondary">{spec.technique}</Badge>}
          {spec.priority && <Badge variant="outline">{spec.priority} priority</Badge>}
          {spec.regression_flag && <Badge variant="info">regression</Badge>}
        </div>
      </header>

      {/* 2. Objective */}
      <DetailSection title="Objective">
        <p className="border-l-2 pl-4 text-base leading-relaxed">{spec.objective}</p>
      </DetailSection>

      {/* 3. The forward traceability link - the point of this page */}
      <DetailSection title="Verifies requirements">
        {coveredIds.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {coveredIds.map((reqId) => (
              <RequirementLink
                key={reqId}
                reqId={reqId}
                versionIndex={versionIndex}
                title={titleIndex.get(reqId)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            None &mdash; this test case covers no requirement.
          </p>
        )}
        {requirementsLoading && (
          <p className="text-xs text-muted-foreground">
            Resolving requirement versions&hellip;
          </p>
        )}
      </DetailSection>

      {/* 4. When the case is valid */}
      <DetailSection title="Criteria for a valid run">
        <DefinitionGrid
          rows={[
            { label: "Entry criteria", value: spec.entry_criteria },
            { label: "Exit criteria", value: spec.exit_criteria },
            { label: "Verification method", value: spec.verification_method },
            { label: "Test environment", value: spec.test_environment },
          ]}
        />
      </DetailSection>

      {/* 5. Pass criteria as data */}
      <DetailSection title="Pass criteria">
        <PassCriteriaTable
          criteria={spec.pass_criteria ?? []}
          logic={spec.pass_criteria_logic}
          versionIndex={versionIndex}
        />
      </DetailSection>

      {/* 6. What the run has to deliver for the criteria to be evaluable */}
      <DetailSection title="Data requirements">
        {dataRequirements ? (
          <div className="space-y-3">
            <DefinitionGrid
              rows={[
                {
                  label: "Traces",
                  value: `${dataRequirements.min_traces} minimum${
                    dataRequirements.trace_required ? " (required)" : " (optional)"
                  }`,
                },
                {
                  label: "Channel groups",
                  value: (
                    <ChipList values={dataRequirements.required_channel_groups ?? []} />
                  ),
                },
                {
                  label: "Required signals",
                  value: <ChipList values={dataRequirements.required_signals ?? []} />,
                },
              ]}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            None &mdash; this test case declares no data requirements.
          </p>
        )}
      </DetailSection>

      {/* 7. Notes - provenance prose, rendered in full and never reordered */}
      <DetailSection title="Notes">
        {spec.notes ? (
          <p className="text-sm leading-relaxed">{spec.notes}</p>
        ) : (
          <p className="text-sm text-muted-foreground">None &mdash; no notes recorded.</p>
        )}
      </DetailSection>

      {/* 8. Provenance of the record itself */}
      <DetailSection title="Record">
        <DefinitionGrid
          rows={[
            { label: "Key", value: <span className="font-mono text-xs">{spec.key}</span> },
            {
              label: "Implementation",
              value: spec.impl_ref ? (
                <span className="font-mono text-xs">{spec.impl_ref}</span>
              ) : (
                <span className="text-muted-foreground">
                  Not linked &mdash; no implementation reference on this record
                </span>
              ),
            },
            { label: "Last change", value: spec.last_change ?? "" },
            {
              label: "Canonical sha256",
              value: (
                <span className="break-all font-mono text-xs">{spec.canonical_sha256}</span>
              ),
            },
          ]}
        />
      </DetailSection>
    </article>
  )
}

/** Monospace chips for signal / channel-group lists. */
function ChipList({ values }: { values: string[] }) {
  if (values.length === 0) {
    return <span className="text-muted-foreground">&mdash;</span>
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {values.map((value) => (
        <span
          key={value}
          className="rounded border bg-muted/30 px-1.5 py-0.5 font-mono text-xs"
        >
          {value}
        </span>
      ))}
    </div>
  )
}

"use client"

import { useState } from "react"
import Link from "next/link"

import { Badge } from "@/components/ui/badge"
import { DefinitionGrid, DetailSection } from "./detail-section"
import { PassCriteriaTable } from "./pass-criteria-table"
import { RequirementLink } from "./requirement-link"
import { TruncatedText } from "./truncated-text"
import { useVariant } from "@/lib/contexts/variant-context"
import { cn } from "@/lib/utils"
import type { TestSpec } from "@/types/vmodel"

interface TestSpecDetailProps {
  spec: TestSpec | null
  versionIndex: Map<string, string>
  titleIndex: Map<string, string>
  requirementsLoading: boolean
}

/**
 * Region C for the Test Specification stage.
 *
 * Three layouts, switchable via the palette picker:
 *
 * Common — single-column scroll. Open: objective, verifies requirements, steps,
 * pass criteria, implemented-by link. Collapsed: entry/exit criteria, scenario,
 * data requirements, notes, record. The original layout.
 *
 * Editorial — three tabs: Overview / Evidence / Setup. The reader sees the
 * objective and traceability immediately without scrolling past criteria tables.
 *
 * Showcase — tc_id, title, coverage pill, objective, verifies, pass criteria,
 * implementation link. Steps and all setup/provenance collapsed. Audience: demo
 * viewers who want to confirm what the test covers and what pass means.
 */
export function TestSpecDetail({
  spec,
  versionIndex,
  titleIndex,
  requirementsLoading,
}: TestSpecDetailProps) {
  const { variant } = useVariant()
  const [tab, setTab] = useState<"overview" | "evidence" | "setup">("overview")

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

  const coveredIds = spec.covers_req_ids ?? []
  const dataRequirements = spec.data_requirements

  const stimulus = (spec.stimulus ?? {}) as Record<string, unknown>
  const scenario = (
    [
      ["Scenario", stimulus.scenario_ref],
      ["Config", stimulus.config_ref],
      ["Notes", stimulus.notes],
    ] as const
  )
    .filter(([, v]) => typeof v === "string" && v.length > 0)
    .map(([label, value]) => ({ label, value: value as string }))

  // ── Section definitions (shared across all layouts) ─────────────────────

  const headerSection = (
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
  )

  const objectiveSection = (
    <DetailSection title="Objective">
      <TruncatedText
        text={spec.objective ?? ""}
        className="border-l-2 pl-4 text-base leading-relaxed"
      />
    </DetailSection>
  )

  const verifiesSection = (
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
  )

  const validRunSection = (
    <DetailSection
      title="Criteria for a valid run"
      collapsible
      defaultOpen={false}
      closedSummary="entry, exit criteria, test environment"
    >
      <DefinitionGrid
        rows={[
          { label: "Entry criteria", value: spec.entry_criteria },
          { label: "Exit criteria", value: spec.exit_criteria },
          { label: "Verification method", value: spec.verification_method },
          { label: "Test environment", value: spec.test_environment },
        ]}
      />
    </DetailSection>
  )

  const stepsSection =
    (spec.steps?.length ?? 0) > 0 ? (
      <DetailSection title="Test steps">
        <ol className="space-y-3">
          {(spec.steps ?? []).map((step, i) => (
            <li key={step.step_no ?? i} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
                {step.step_no ?? i + 1}
              </span>
              <div className="space-y-1">
                {step.action && <p className="text-sm leading-snug">{step.action}</p>}
                {step.expected && (
                  <p className="text-sm leading-snug text-muted-foreground">
                    <span className="font-medium">Expected: </span>
                    {step.expected}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </DetailSection>
    ) : null

  const scenarioSection =
    scenario.length > 0 ? (
      <DetailSection
        title="Scenario"
        collapsible
        defaultOpen={false}
        closedSummary="scenario and config references"
      >
        <DefinitionGrid rows={scenario} />
      </DetailSection>
    ) : null

  const passCriteriaSection = (
    <DetailSection title="Pass criteria">
      <PassCriteriaTable
        criteria={spec.pass_criteria ?? []}
        logic={spec.pass_criteria_logic}
        versionIndex={versionIndex}
      />
    </DetailSection>
  )

  const dataRequirementsSection = (
    <DetailSection
      title="Data requirements"
      collapsible
      defaultOpen={false}
      closedSummary="required signals and trace count"
    >
      {dataRequirements ? (
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
              value: <ChipList values={dataRequirements.required_channel_groups ?? []} />,
            },
            {
              label: "Required signals",
              value: <ChipList values={dataRequirements.required_signals ?? []} />,
            },
          ]}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          None &mdash; this test case declares no data requirements.
        </p>
      )}
    </DetailSection>
  )

  const implSection = spec.impl_ref ? (
    <DetailSection title="Implemented by">
      <Link
        href="/test-implementations"
        title={`QuixLab cell ${spec.impl_ref.toLowerCase().replace(/-/g, "_")}`}
        className="inline-flex items-baseline gap-2 rounded-full border px-2.5 py-0.5 transition-colors hover:bg-accent hover:text-accent-foreground"
      >
        <span className="font-mono text-xs">{spec.impl_ref}</span>
        <span className="max-w-xs truncate text-xs">
          {spec.impl_ref.toLowerCase().replace(/-/g, "_")}
        </span>
      </Link>
    </DetailSection>
  ) : null

  const notesSection = (
    <DetailSection
      title="Notes"
      collapsible
      defaultOpen={false}
      closedSummary="provenance and remarks"
    >
      {spec.notes ? (
        <TruncatedText text={spec.notes} className="text-sm leading-relaxed" />
      ) : (
        <p className="text-sm text-muted-foreground">None &mdash; no notes recorded.</p>
      )}
    </DetailSection>
  )

  const recordSection = (
    <DetailSection
      title="Record"
      collapsible
      defaultOpen={false}
      closedSummary="key, sha256, last change"
    >
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
  )

  // ── SHOWCASE: key spec facts up front, detail collapsed ─────────────────
  // A demo audience wants to see: what this test covers (requirements),
  // what pass looks like (criteria), and whether it is implemented. The
  // full steps, scenario config and provenance are reference material —
  // collapsed and reachable, never pushed into view.
  if (variant === "showcase") {
    const reqCount = coveredIds.length

    return (
      <article className="mx-auto max-w-4xl space-y-6 p-6">
        {/* Header: id, title, and coverage count */}
        <div className="space-y-4 rounded-lg border bg-muted/20 p-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {spec.artifact_version}
              </span>
              {spec.mnemonic && (
                <span className="font-mono text-xs text-muted-foreground">
                  · {spec.mnemonic}
                </span>
              )}
            </div>
            <h1 className="mt-1 font-mono text-3xl font-semibold tracking-tight">
              {spec.tc_id}
            </h1>
            <p className="mt-2 text-xl leading-snug">{spec.title}</p>
          </div>

          {/* Coverage count — the number the audience cares about */}
          <div className="flex flex-wrap gap-3 pt-1">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium",
                reqCount > 0
                  ? "border-transparent bg-muted text-primary"
                  : "border-border text-muted-foreground"
              )}
            >
              {reqCount > 0
                ? `Covers ${reqCount} requirement${reqCount === 1 ? "" : "s"}`
                : "Covers no requirements"}
            </span>
            {spec.technique && (
              <Badge variant="secondary">{spec.technique}</Badge>
            )}
            {spec.priority && (
              <Badge variant="outline">{spec.priority} priority</Badge>
            )}
          </div>
        </div>

        {/* Objective — the one-line purpose, most useful for a demo */}
        {objectiveSection}

        {/* Requirements this TC covers — the traceability link */}
        {verifiesSection}

        {/* Pass criteria — what counts as passing; visible because this is
            the key specification fact for a non-technical audience */}
        {passCriteriaSection}

        {/* Implementation link, if present */}
        {implSection}

        {/* Everything else collapsed — steps, scenario, data, provenance */}
        {stepsSection && (
          <DetailSection
            title="Test steps"
            collapsible
            defaultOpen={false}
            closedSummary="step-by-step actions and expected results"
          >
            <ol className="space-y-3">
              {(spec.steps ?? []).map((step, i) => (
                <li key={step.step_no ?? i} className="flex gap-3">
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted font-mono text-xs">
                    {step.step_no ?? i + 1}
                  </span>
                  <div className="space-y-1">
                    {step.action && <p className="text-sm leading-snug">{step.action}</p>}
                    {step.expected && (
                      <p className="text-sm leading-snug text-muted-foreground">
                        <span className="font-medium">Expected: </span>
                        {step.expected}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </DetailSection>
        )}
        {validRunSection}
        {scenarioSection}
        {dataRequirementsSection}
        {notesSection}
        {recordSection}
      </article>
    )
  }

  // ── EDITORIAL: tab-segmented layout ─────────────────────────────────────
  // Structural change: Overview (what this case is) / Evidence (how to run it
  // and what pass looks like) / Setup (criteria, scenario, data, provenance).
  if (variant === "editorial") {
    return (
      <article className="mx-auto max-w-4xl p-6">
        {headerSection}
        <div className="mt-6">
          <div className="flex border-b" role="tablist">
            {(
              [
                { id: "overview", label: "Overview" },
                { id: "evidence", label: "Evidence" },
                { id: "setup", label: "Setup" },
              ] as const
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                  tab === id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mt-6 space-y-6">
            {tab === "overview" && (
              <>
                {objectiveSection}
                {verifiesSection}
                {implSection}
              </>
            )}
            {tab === "evidence" && (
              <>
                {stepsSection}
                {passCriteriaSection}
              </>
            )}
            {tab === "setup" && (
              <>
                {validRunSection}
                {scenarioSection}
                {dataRequirementsSection}
                {notesSection}
                {recordSection}
              </>
            )}
          </div>
        </div>
      </article>
    )
  }

  // ── COMMON: single-column scroll, the layout the app always had ─────────
  return (
    <article className="mx-auto max-w-4xl space-y-6 p-6">
      {headerSection}
      {objectiveSection}
      {verifiesSection}
      {validRunSection}
      {stepsSection}
      {scenarioSection}
      {passCriteriaSection}
      {dataRequirementsSection}
      {implSection}
      {notesSection}
      {recordSection}
    </article>
  )
}

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

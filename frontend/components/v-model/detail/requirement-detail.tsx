"use client"

import { useState } from "react"
import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ProvenanceBadge } from "../provenance-badge"
import { StatusBadge } from "../status-badge"
import { CoveringSpecsSection } from "./covering-specs-section"
import { DefinitionGrid, DetailSection } from "./detail-section"
import { FigureSvg } from "./figure-svg"
import { TruncatedText } from "./truncated-text"
import { useVariant } from "@/lib/contexts/variant-context"
import { cn } from "@/lib/utils"
import { VMODEL_API_BASE } from "@/lib/vmodel/constants"
import type {
  FigureReference,
  Requirement,
  RequirementDetail as RequirementDetailData,
  TestSpec,
} from "@/types/vmodel"

interface RequirementDetailProps {
  summary: Requirement | null
  detail: RequirementDetailData | null
  detailLoading: boolean
  detailError: Error | null
  coveringSpecs: TestSpec[]
  coveringSpecsLoading: boolean
  coveringSpecsUnavailable: boolean
}

/**
 * Region C for the Requirements stage.
 *
 * Three layouts, switchable via the palette picker:
 *
 * Common — single-column scroll. All sections stacked. Metadata (attributes,
 * rationale, source, record) collapsed by default. The original layout.
 *
 * Editorial — tab-segmented. Overview / Metadata / Provenance tabs replace the
 * single scroll, so the reader is never pushed past reference material to reach
 * the content they want.
 *
 * Showcase — req_id, title, and two status pills (Covered / Tested). Everything
 * else collapsed. Audience: demo viewers who need to confirm traceability at a
 * glance without reading the full specification.
 */
export function RequirementDetail({
  summary,
  detail,
  detailLoading,
  detailError,
  coveringSpecs,
  coveringSpecsLoading,
  coveringSpecsUnavailable,
}: RequirementDetailProps) {
  const { variant } = useVariant()
  const [tab, setTab] = useState<"overview" | "metadata" | "provenance">("overview")

  if (!summary) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-sm text-center text-sm text-muted-foreground">
          Select a requirement in the tree to see its full text, rationale, sources and
          figures.
        </p>
      </div>
    )
  }

  const item = detail ?? summary
  const figures: FigureReference[] =
    detail?.figures ??
    (summary.figure_refs ?? []).map((figureId) => ({
      figure_id: figureId,
      title: figureId,
      url: `/api/v1${VMODEL_API_BASE}/figures/${figureId}`,
    }))

  // ── Section definitions (shared across all layouts) ─────────────────────

  const headerSection = (
    <header className="space-y-3">
      <h1 className="font-mono text-2xl font-semibold tracking-tight">{item.req_id}</h1>
      <p className="text-lg leading-snug">{item.title}</p>
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={item.status} />
        <Badge variant="secondary">rev {item.revision}</Badge>
        <Badge variant="outline" className="font-mono">
          {item.artifact_version}
        </Badge>
        <ProvenanceBadge verificationTag={item.verification_tag} />
        {item.verification_method && (
          <Badge variant="secondary">{item.verification_method}</Badge>
        )}
        <CoverageBadge covering={detail?.covering_tc_ids} />
      </div>
    </header>
  )

  const textSection = (
    <DetailSection title="Requirement text">
      <TruncatedText
        text={item.text ?? ""}
        className="border-l-2 pl-4 text-base leading-relaxed"
      />
    </DetailSection>
  )

  const attributesSection = (
    <DetailSection
      title="Attributes"
      collapsible
      defaultOpen={false}
      closedSummary="chapter, EARS pattern, verification method"
    >
      <DefinitionGrid
        rows={[
          { label: "Chapter", value: item.chapter },
          { label: "EARS pattern", value: item.ears_pattern },
          { label: "System states", value: joinList(item.system_states) },
          { label: "Verification method", value: item.verification_method },
          {
            label: "Measurand",
            value: (item.measurand ?? [])
              .map((m) => `${m.name} (${m.unit})`)
              .join(", "),
          },
          { label: "Last change", value: item.last_change ?? "" },
          {
            label: "Verified by",
            value:
              (item.verified_by ?? []).length > 0 ? (
                joinList(item.verified_by)
              ) : (
                <span className="text-muted-foreground">
                  None &mdash; no verification evidence recorded
                </span>
              ),
          },
        ]}
      />
    </DetailSection>
  )

  const rationaleSection = (
    <DetailSection
      title="Rationale"
      collapsible
      defaultOpen={false}
      closedSummary="design decision background"
    >
      <TruncatedText text={item.rationale ?? ""} className="text-sm leading-relaxed" />
    </DetailSection>
  )

  const sourceSection = (
    <DetailSection
      title="Source"
      collapsible
      defaultOpen={false}
      closedSummary="normative references"
    >
      {(item.source ?? []).length > 0 ? (
        <ul className="space-y-1">
          {item.source.map((src) => (
            <li key={src} className="font-mono text-sm">
              {src}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          None &mdash; no source clause recorded.
        </p>
      )}
    </DetailSection>
  )

  const figuresSection = figures.length > 0 ? (
    <DetailSection title="Figures">
      <div className="space-y-4">
        {figures.map((figure) => (
          <figure key={figure.figure_id} className="space-y-1">
            <FigureSvg
              endpoint={`${VMODEL_API_BASE}/figures/${figure.figure_id}`}
              title={figure.title || figure.figure_id}
            />
            <figcaption className="text-xs text-muted-foreground">
              {figure.figure_id}
              {figure.title && figure.title !== figure.figure_id && (
                <> &mdash; {figure.title}</>
              )}
            </figcaption>
          </figure>
        ))}
      </div>
    </DetailSection>
  ) : null

  const relatedSection = (
    <DetailSection title="Related requirements">
      {(item.related_reqs ?? []).length > 0 ? (
        <div className="flex flex-wrap gap-2">
          {item.related_reqs.map((relatedId) => (
            <Link
              key={relatedId}
              href={`/requirements?select=${encodeURIComponent(
                `${relatedId}@${item.artifact_version}`
              )}`}
              className="rounded-full border px-2.5 py-0.5 font-mono text-xs transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {relatedId}
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          None &mdash; this requirement has no related requirements.
        </p>
      )}
    </DetailSection>
  )

  const coveringSection = (
    <CoveringSpecsSection
      specs={coveringSpecs}
      loading={coveringSpecsLoading}
      unavailable={coveringSpecsUnavailable}
    />
  )

  const recordSection = (
    <DetailSection
      title="Record"
      collapsible
      defaultOpen={false}
      closedSummary="key, sha256, versions"
    >
      <DefinitionGrid
        rows={[
          { label: "Key", value: <span className="font-mono text-xs">{item.key}</span> },
          {
            label: "Canonical sha256",
            value: (
              <span className="break-all font-mono text-xs">{item.canonical_sha256}</span>
            ),
          },
          {
            label: "Versions",
            value: detail?.available_versions?.length
              ? joinList(detail.available_versions)
              : "",
          },
          {
            label: "Baselines",
            value: detail?.baseline_ids?.length ? joinList(detail.baseline_ids) : "",
          },
        ]}
      />
      {detailLoading && <Skeleton className="h-4 w-48" />}
      {detailError && (
        <p className="text-xs text-muted-foreground">
          Extended detail is unavailable ({detailError.message}).
        </p>
      )}
    </DetailSection>
  )

  // ── SHOWCASE: the four facts a demo audience needs ──────────────────────
  // User brief: "for showcase it's important: id of req, name and if it
  // covered and tested". Covered and tested are two distinct states — a
  // requirement can be covered (a test case exists) but not tested (the test
  // has not run or failed). The pills must never conflate them.
  // Everything else is collapsed — reachable but not on screen.
  if (variant === "showcase") {
    const coveringCount = (detail?.covering_tc_ids ?? []).length
    const testedCount = (item.verified_by ?? []).length
    const isCovered = coveringCount > 0
    const isTested = testedCount > 0

    return (
      <article className="mx-auto max-w-4xl space-y-6 p-6">
        {/* The four facts: id, name, covered, tested */}
        <div className="space-y-4 rounded-lg border bg-muted/20 p-6">
          <div>
            <h1 className="font-mono text-3xl font-semibold tracking-tight">
              {item.req_id}
            </h1>
            <p className="mt-2 text-xl leading-snug">{item.title}</p>
          </div>

          {/* Two independent status pills — covered ≠ tested */}
          <div className="flex flex-wrap gap-3 pt-1">
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium",
                isCovered
                  ? "border-transparent bg-muted text-primary"
                  : "border-border text-muted-foreground"
              )}
            >
              {isCovered
                ? `Covered · ${coveringCount} test case${coveringCount === 1 ? "" : "s"}`
                : "Not covered"}
            </span>
            <span
              className={cn(
                "inline-flex items-center rounded-full border px-3 py-1 text-sm font-medium",
                isTested
                  ? "border-transparent bg-muted text-neon-pass"
                  : "border-border text-muted-foreground"
              )}
            >
              {isTested
                ? `Tested · ${testedCount} passing`
                : "Not tested"}
            </span>
          </div>
        </div>

        {/* Everything else behind collapsed sections — reachable but not on screen */}
        <DetailSection
          title="Requirement text"
          collapsible
          defaultOpen={false}
          closedSummary="the full requirement statement"
        >
          <TruncatedText
            text={item.text ?? ""}
            className="border-l-2 pl-4 text-base leading-relaxed"
          />
        </DetailSection>
        {attributesSection}
        {rationaleSection}
        {sourceSection}
        {recordSection}
      </article>
    )
  }

  // ── EDITORIAL: tab-segmented layout ─────────────────────────────────────
  // Structural change: three tabs replace the single scroll. The reader
  // sees Overview (the content) first; Metadata and Provenance are one click
  // away but do not push the traceability links below the fold.
  if (variant === "editorial") {
    return (
      <article className="mx-auto max-w-4xl p-6">
        {headerSection}
        <div className="mt-6">
          <div className="flex border-b" role="tablist">
            {(
              [
                { id: "overview", label: "Overview" },
                { id: "metadata", label: "Metadata" },
                { id: "provenance", label: "Provenance" },
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
                {textSection}
                {relatedSection}
                {coveringSection}
                {figuresSection}
              </>
            )}
            {tab === "metadata" && (
              <>
                {attributesSection}
                {rationaleSection}
              </>
            )}
            {tab === "provenance" && (
              <>
                {sourceSection}
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
      {textSection}
      {attributesSection}
      {rationaleSection}
      {sourceSection}
      {figuresSection}
      {relatedSection}
      {coveringSection}
      {recordSection}
    </article>
  )
}

function joinList(values: string[] | undefined): string {
  return (values ?? []).join(", ")
}

interface CoverageBadgeProps {
  covering: string[] | undefined
}

function CoverageBadge({ covering }: CoverageBadgeProps) {
  if (covering === undefined) return null
  return covering.length > 0 ? (
    <Badge variant="secondary">covered by {covering.join(", ")}</Badge>
  ) : (
    <Badge variant="outline">uncovered</Badge>
  )
}


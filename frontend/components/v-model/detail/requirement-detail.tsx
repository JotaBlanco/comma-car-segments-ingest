"use client"

import Link from "next/link"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import { ProvenanceBadge } from "../provenance-badge"
import { StatusBadge } from "../status-badge"
import { CoveringSpecsSection } from "./covering-specs-section"
import { DefinitionGrid, DetailSection } from "./detail-section"
import { FigureSvg } from "./figure-svg"
import { VMODEL_API_BASE } from "@/lib/vmodel/constants"
import type {
  FigureReference,
  Requirement,
  RequirementDetail as RequirementDetailData,
  TestSpec,
} from "@/types/vmodel"

interface RequirementDetailProps {
  /** The row from the list - always available once a leaf is selected. */
  summary: Requirement | null
  /** The enriched detail call; may still be loading or may have failed. */
  detail: RequirementDetailData | null
  detailLoading: boolean
  detailError: Error | null
  /**
   * Reverse traceability: the test specs whose `covers_req_ids[]` names this
   * requirement, resolved client-side from the loaded spec register.
   */
  coveringSpecs: TestSpec[]
  coveringSpecsLoading: boolean
  coveringSpecsUnavailable: boolean
}

/**
 * Region C for the Requirements stage.
 *
 * Technical, not decorative: identifier, badges, the "shall" sentence, a
 * definition grid, rationale, sources, figures and related requirements. It
 * renders from the list row immediately and layers the enriched detail (resolved
 * figures, available versions) on top when that call returns, so a slow or
 * missing detail endpoint degrades instead of blanking the pane.
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

  return (
    <article className="mx-auto max-w-4xl space-y-6 p-6">
      {/* 1. Header */}
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

      {/* 2. Requirement text - the single "shall" sentence */}
      <DetailSection title="Requirement text">
        <p className="border-l-2 pl-4 text-base leading-relaxed">{item.text}</p>
      </DetailSection>

      {/* 3. Definition grid */}
      <DetailSection title="Attributes">
        <DefinitionGrid
          rows={[
            { label: "Chapter", value: item.chapter },
            { label: "EARS pattern", value: item.ears_pattern },
            { label: "System states", value: joinList(item.system_states) },
            { label: "Verification method", value: item.verification_method },
            {
              label: "Measurand",
              value: (item.measurand ?? [])
                .map((measurand) => `${measurand.name} (${measurand.unit})`)
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
                    None &mdash; no verification evidence recorded on this requirement
                  </span>
                ),
            },
          ]}
        />
      </DetailSection>

      {/* 4. Rationale - its first sentence is the provenance column, never reordered */}
      <DetailSection title="Rationale">
        <p className="text-sm leading-relaxed">{item.rationale}</p>
      </DetailSection>

      {/* 5. Source clauses */}
      <DetailSection title="Source">
        {(item.source ?? []).length > 0 ? (
          <ul className="space-y-1">
            {item.source.map((source) => (
              <li key={source} className="font-mono text-sm">
                {source}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            None &mdash; no source clause recorded.
          </p>
        )}
      </DetailSection>

      {/* 6. Figures - the image that completes the info */}
      {figures.length > 0 && (
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
      )}

      {/* 7. Related requirements - deep links into this same page */}
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

      {/* 8. Reverse traceability - what verifies this requirement */}
      <CoveringSpecsSection
        specs={coveringSpecs}
        loading={coveringSpecsLoading}
        unavailable={coveringSpecsUnavailable}
      />

      {/* Provenance of the record itself */}
      <DetailSection title="Record">
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
            Extended detail is unavailable ({detailError.message}). The fields above come
            from the register listing.
          </p>
        )}
      </DetailSection>
    </article>
  )
}

function joinList(values: string[] | undefined): string {
  return (values ?? []).join(", ")
}

interface CoverageBadgeProps {
  covering: string[] | undefined
}

/** Coverage is derived from the pinned baseline, never from `verified_by`. */
function CoverageBadge({ covering }: CoverageBadgeProps) {
  if (covering === undefined) return null
  return covering.length > 0 ? (
    <Badge variant="secondary">covered by {covering.join(", ")}</Badge>
  ) : (
    <Badge variant="outline">uncovered</Badge>
  )
}

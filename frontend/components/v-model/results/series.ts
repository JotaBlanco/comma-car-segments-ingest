/**
 * Pure helpers for the plotted half of the Test Report.
 *
 * Separate from `verdict.ts` because that file is the verdict arithmetic and this is
 * presentation of the numbers a criterion produced. The one rule shared with it: a value
 * that does not exist is never rendered as zero.
 */

import type { CaseSeries, CriterionChart } from "@/types/vm-execution"

/**
 * A measured value, to the precision the criterion was judged at.
 *
 * Four decimals below 10, three above. That is not cosmetic: ACC-SYS-TC-014 is decided by
 * a 2 s moving average of -3.8240 m/s2 against a -3.5 bound, and rounding it to -3.82
 * would print a different number from the one the check compared.
 */
export function formatMeasured(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  return value.toFixed(Math.abs(value) < 10 ? 4 : 3)
}

/** A bound as the spec writes it: `100.5`, `22.3333`, `-3.5`, `180.0`. */
export function formatBound(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  return Number.isInteger(value) ? value.toFixed(1) : String(value)
}

/** The signed distance to the bound. Negative means the criterion was violated. */
export function formatMargin(value: number | null | undefined): string | null {
  if (value === null || value === undefined || Number.isNaN(value)) return null
  const text = Math.abs(value) < 10 ? value.toFixed(4) : value.toFixed(3)
  return value > 0 ? `+${text}` : text
}

/** "max 100.070 <= 100.5 km/h" - the whole criterion on one line. */
export function chartHeadline(chart: CriterionChart): string {
  const measured = formatMeasured(chart.measured)
  const bound = formatBound(chart.bound)
  if (measured === null || bound === null) return "not measured"
  const unit = chart.unit ? ` ${chart.unit}` : ""
  return `${measured} ${chart.comparison} ${bound}${unit}`
}

/** How far the bound was missed by, in the criterion's own unit. Null when it was met. */
export function overshoot(chart: CriterionChart): string | null {
  if (chart.verdict === "PASS" || chart.measured === null || chart.bound === null) return null
  const gap = Math.abs(chart.measured - chart.bound)
  return `${gap < 10 ? gap.toFixed(4) : gap.toFixed(3)}${chart.unit ? ` ${chart.unit}` : ""}`
}

/** Total seconds spent outside the bound, summed over the breach spans. */
export function breachSeconds(chart: CriterionChart): number {
  return chart.spans
    .filter((span) => span.kind === "breach")
    .reduce((total, span) => total + (span.t_end_s - span.t_start_s), 0)
}

/** Index the run's plot documents by test case id. */
export function indexSeries(series: CaseSeries[]): Map<string, CaseSeries> {
  return new Map(series.map((item) => [item.tc_id, item]))
}

/** Where the samples came from, in words a customer can read. */
export function sourceLabel(source: string): string {
  return source === "lake" ? "lakehouse mf4_signals_v4" : "committed signal fixture"
}

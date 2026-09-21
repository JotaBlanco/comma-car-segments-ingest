/**
 * Renders a machine-evaluable pass criterion as short human text - pure, no React.
 *
 * The rule here is the one from the brief: criteria must read as DATA, never as
 * prose and never as a raw JSON dump. Every formatter degrades to naming the
 * operator it did not recognise, so a new op from the backend shows up as
 * `op value` instead of blanking the cell.
 */

import type {
  CriterionReduce,
  CriterionRule,
  CriterionTolerance,
  CriterionWindow,
} from "@/types/vmodel"

/** Comparison operators, in their mathematical form. */
const RULE_SYMBOLS: Record<string, string> = {
  le: "\u2264",
  lt: "<",
  ge: "\u2265",
  gt: ">",
  eq: "=",
  ne: "\u2260",
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (Array.isArray(value)) return value.map(formatScalar).join(", ")
  if (typeof value === "object") return ""
  return String(value)
}

/** " (all samples)" / " (any sample)" - the quantifier is load-bearing, not noise. */
function quantifierSuffix(quantifier: string | null | undefined): string {
  if (quantifier === "all") return " (all samples)"
  if (quantifier === "any") return " (any sample)"
  return ""
}

/**
 * The comparison itself: `\u2264 3 s`, `within 98 \u2026 102 km/h`, `= 1`.
 * `unit` is appended when the criterion declares one other than the
 * dimensionless "1".
 */
export function formatRule(
  rule: CriterionRule | null | undefined,
  unit?: string | null
): string {
  if (!rule?.op) return "\u2014"

  const suffix = unit && unit !== "1" ? ` ${unit}` : ""
  const value = formatScalar(rule.value)
  const quantifier = quantifierSuffix(rule.quantifier)

  if (rule.op === "within") {
    return `within ${value} \u2026 ${formatScalar(rule.value2)}${suffix}${quantifier}`
  }
  if (rule.op === "equals_enum") {
    return `in {${value}}${quantifier}`
  }

  const symbol = RULE_SYMBOLS[rule.op]
  if (symbol) {
    return `${symbol} ${value}${suffix}${quantifier}`
  }
  return `${rule.op} ${value}${suffix}${quantifier}`.trim()
}

/** One edge of a `time_between_edges` reduce: `VehStandstill_Flg rising`. */
function formatEdge(edge: Record<string, unknown> | null | undefined): string {
  if (!edge) return "?"
  const signal = formatScalar(edge.signal)
  const kind = formatScalar(edge.kind)
  const value = edge.value === undefined ? "" : ` ${formatScalar(edge.value)}`
  return `${signal} ${kind}${value}`.trim()
}

/**
 * How the signal is reduced to the single value the rule compares:
 * `max`, `mean`, `moving average 2 s`, `time from A rising to B to_value 4`.
 */
export function formatReduce(reduce: CriterionReduce | null | undefined): string {
  if (!reduce?.op) return "\u2014"

  switch (reduce.op) {
    case "none":
      return "raw samples"
    case "moving_average":
      return `moving average ${formatScalar(reduce.window_s)} s`
    case "count_edges":
      return `count ${formatScalar(reduce.edge)} edges`
    case "derivative":
      return `derivative${reduce.method ? ` (${formatScalar(reduce.method)})` : ""}`
    case "time_between_edges": {
      const from = formatEdge(reduce.from as Record<string, unknown> | null)
      const to = formatEdge(reduce.to as Record<string, unknown> | null)
      const occurrence = reduce.occurrence ? `, ${formatScalar(reduce.occurrence)}` : ""
      return `time from ${from} to ${to}${occurrence}`
    }
    case "abs_max":
      return "abs max"
    default:
      return String(reduce.op).replace(/_/g, " ")
  }
}

/**
 * The slice of the trace the criterion is evaluated over. `all_of` recurses over
 * its parts so a compound window still reads as one line.
 */
export function formatWindow(window: CriterionWindow | null | undefined): string {
  if (!window?.type) return "\u2014"

  switch (window.type) {
    case "full":
      return "full trace"
    case "state_mask": {
      const parts = [
        `${formatScalar(window.signal)} in {${formatScalar(window.in)}}`,
      ]
      if (window.min_duration_s !== undefined && window.min_duration_s !== null) {
        parts.push(`\u2265 ${formatScalar(window.min_duration_s)} s`)
      }
      if (window.settle_s !== undefined && window.settle_s !== null) {
        parts.push(`settle ${formatScalar(window.settle_s)} s`)
      }
      return parts.join(", ")
    }
    case "signal_threshold": {
      const symbol = RULE_SYMBOLS[String(window.op)] ?? String(window.op)
      return `${formatScalar(window.signal)} ${symbol} ${formatScalar(window.value)}`
    }
    case "time_range":
      return `${formatScalar(window.t_start_s)} \u2013 ${formatScalar(window.t_end_s)} s`
    case "all_of": {
      const parts = Array.isArray(window.parts) ? (window.parts as CriterionWindow[]) : []
      return parts.map(formatWindow).join(" and ")
    }
    default:
      return String(window.type).replace(/_/g, " ")
  }
}

/** `\u00b10.05` / `\u00b11%` / an em dash when the criterion declares none. */
export function formatTolerance(
  tolerance: CriterionTolerance | null | undefined
): string {
  if (!tolerance) return "\u2014"
  const parts: string[] = []
  if (tolerance.abs !== null && tolerance.abs !== undefined) {
    parts.push(`\u00b1${tolerance.abs}`)
  }
  if (tolerance.rel !== null && tolerance.rel !== undefined) {
    parts.push(`\u00b1${tolerance.rel * 100}%`)
  }
  return parts.length > 0 ? parts.join(" / ") : "\u2014"
}

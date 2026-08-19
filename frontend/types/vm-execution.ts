/**
 * Types for Test Run execution and the plot data it produces.
 *
 * Mirrors `backend/api/vm_eval/charts.py` and `backend/api/vm_eval/runner.py`.
 * They live in their own file rather than in `types/vmodel.ts` because that file is
 * shared with neighbouring V-model work; nothing here needs to be edited by anyone
 * building the run list or the spec explorer.
 */

import type { RunDetailSummary } from "./vmodel"

/** Where the samples a verdict was computed from came from. */
export type SignalSource = "lake" | "fixture"

/** One line on a chart. `points` are `[t_s, value]`, decimated, time-ordered. */
export interface ChartSeries {
  series_id: string
  label: string
  unit: string
  /** `signal` is measured; `derived` was computed by the criterion (a moving average). */
  kind: "signal" | "derived"
  /** `context` lines are drawn faint - no criterion reads them. */
  role: "primary" | "context"
  points: number[][]
}

/** A horizontal reference line: the bound the criterion is judged against. */
export interface ChartBound {
  label: string
  value: number
  kind: "bound" | "tolerance"
}

/** A shaded time range: the evaluated window, or a stretch that violates the bound. */
export interface ChartSpan {
  label: string
  t_start_s: number
  t_end_s: number
  kind: "window" | "breach"
}

/** A single called-out sample - the one the reduction picked. */
export interface ChartMarker {
  label: string
  t_s: number
  value: number
  kind: "measured" | "breach"
}

/** One criterion, drawn. */
export interface CriterionChart {
  chart_id: string
  criterion_id: string
  title: string
  caption: string
  y_label: string
  unit: string
  verdict: string
  /** The reduction the criterion applied, e.g. `max` or `moving_average(2 s trailing)`. */
  reduce: string
  /** `<=` | `>=` | `==`, as the report prints it. */
  comparison: string
  measured: number | null
  bound: number | null
  effective_bound: number | null
  margin: number | null
  n_samples: number
  series: ChartSeries[]
  bounds: ChartBound[]
  spans: ChartSpan[]
  markers: ChartMarker[]
}

/** Every chart for one (run, test case). One document of `vm_result_series`. */
export interface CaseSeries {
  key: string
  run_id: string
  tc_id: string
  title: string
  verdict: string
  source: SignalSource
  source_note: string
  scenario: string
  trace_key: string
  sample_count: number
  duration_s: number
  charts: CriterionChart[]
}

/** What happened to one planned test case during a run. */
export interface CaseExecution {
  tc_id: string
  status: string
  source: SignalSource
  trace_key: string
  measured: number | null
  bound: number | null
  unit: string
  n_samples: number
  reason: string
  note: string
}

/** The outcome of one Run action. */
export interface ExecutionReport {
  run_id: string
  executed: CaseExecution[]
  /** Planned test cases with no implementation on the backend; they stay NOT_RUN. */
  skipped: string[]
  /** Cases whose signals could not be read at all. */
  failures: string[]
  sources: SignalSource[]
}

/** Response of `POST /vmodel/runs/{run_id}/execute`. */
export interface RunExecutionResponse {
  report: ExecutionReport
  summary: RunDetailSummary
}

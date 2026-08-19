"use client"

/**
 * Inline SVG chart for one pass criterion.
 *
 * No charting library. The payload is already decimated and carries its own bounds,
 * breach spans and marker (`backend/api/vm_eval/charts.py`), so all this does is map two
 * numeric domains onto a viewBox and draw paths. Adding recharts/visx to draw four
 * polylines would be 200 kB of bundle for geometry that fits on one screen.
 *
 * **Every colour is a theme token.** Stroke and fill come from Tailwind `stroke-*` /
 * `fill-*` utilities bound to the CSS variables in `app/globals.css`, and the axis text
 * uses `currentColor`. Nothing is a hex literal: a hardcoded `#111827` is exactly how the
 * requirement figures ended up invisible in dark mode, and this component is drawn on the
 * same pages.
 */

import { cn } from "@/lib/utils"
import type { ChartSeries, CriterionChart } from "@/types/vm-execution"

const WIDTH = 760
const HEIGHT = 240
const PAD = { top: 14, right: 18, bottom: 28, left: 62 }

const PLOT_W = WIDTH - PAD.left - PAD.right
const PLOT_H = HEIGHT - PAD.top - PAD.bottom

/**
 * Stroke per series. Context lines are muted because no criterion reads them; the two
 * primary slots are the brand blue and the bronze warning, which both hold contrast
 * against the light and the dark background.
 */
const PRIMARY_STROKES = ["stroke-primary", "stroke-warning"]

interface Domain {
  min: number
  max: number
}

function pad(domain: Domain, fraction: number): Domain {
  const span = domain.max - domain.min
  if (span <= 0) {
    const nudge = Math.abs(domain.max) * 0.05 || 1
    return { min: domain.min - nudge, max: domain.max + nudge }
  }
  return { min: domain.min - span * fraction, max: domain.max + span * fraction }
}

function domains(chart: CriterionChart): { x: Domain; y: Domain } {
  let xMin = Number.POSITIVE_INFINITY
  let xMax = Number.NEGATIVE_INFINITY
  let yMin = Number.POSITIVE_INFINITY
  let yMax = Number.NEGATIVE_INFINITY

  for (const series of chart.series) {
    for (const [t, value] of series.points) {
      if (t < xMin) xMin = t
      if (t > xMax) xMax = t
      if (value < yMin) yMin = value
      if (value > yMax) yMax = value
    }
  }
  // The bound has to be on the chart even when the signal never approaches it - a limit
  // line off-canvas is the one thing that would make a PASS unreadable.
  for (const bound of chart.bounds) {
    if (bound.value < yMin) yMin = bound.value
    if (bound.value > yMax) yMax = bound.value
  }

  if (!Number.isFinite(xMin)) return { x: { min: 0, max: 1 }, y: { min: 0, max: 1 } }
  return { x: { min: xMin, max: xMax }, y: pad({ min: yMin, max: yMax }, 0.1) }
}

function ticks(domain: Domain, count: number): number[] {
  const step = (domain.max - domain.min) / count
  return Array.from({ length: count + 1 }, (_, index) => domain.min + step * index)
}

function formatTick(value: number, span: number): string {
  const digits = span >= 100 ? 0 : span >= 10 ? 1 : span >= 1 ? 2 : 3
  return value.toFixed(digits)
}

export function SignalChart({ chart, className }: { chart: CriterionChart; className?: string }) {
  const { x, y } = domains(chart)
  const scaleX = (value: number) =>
    PAD.left + ((value - x.min) / (x.max - x.min || 1)) * PLOT_W
  const scaleY = (value: number) =>
    PAD.top + PLOT_H - ((value - y.min) / (y.max - y.min || 1)) * PLOT_H

  const path = (series: ChartSeries) =>
    series.points
      .map(([t, value], index) => `${index === 0 ? "M" : "L"}${scaleX(t).toFixed(2)},${scaleY(value).toFixed(2)}`)
      .join(" ")

  const ySpan = y.max - y.min
  const xSpan = x.max - x.min
  let primaryIndex = -1

  return (
    <figure className={cn("space-y-2", className)}>
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-auto w-full text-muted-foreground"
        role="img"
        aria-label={`${chart.title}. ${chart.caption}`}
      >
        {/* Breach shading first, so every line is drawn on top of it. */}
        {chart.spans.map((span, index) => (
          <rect
            key={`${span.kind}-${index}`}
            x={scaleX(span.t_start_s)}
            y={PAD.top}
            width={Math.max(1, scaleX(span.t_end_s) - scaleX(span.t_start_s))}
            height={PLOT_H}
            className={span.kind === "breach" ? "fill-destructive/20" : "fill-primary/10"}
          />
        ))}

        {/* Horizontal grid + y axis labels. */}
        {ticks(y, 4).map((value) => (
          <g key={`y-${value}`}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={scaleY(value)}
              y2={scaleY(value)}
              stroke="currentColor"
              strokeOpacity={0.15}
              vectorEffect="non-scaling-stroke"
            />
            <text
              x={PAD.left - 8}
              y={scaleY(value) + 4}
              textAnchor="end"
              fontSize={11}
              fill="currentColor"
            >
              {formatTick(value, ySpan)}
            </text>
          </g>
        ))}

        {/* x axis labels. */}
        {ticks(x, 6).map((value) => (
          <text
            key={`x-${value}`}
            x={scaleX(value)}
            y={HEIGHT - 8}
            textAnchor="middle"
            fontSize={11}
            fill="currentColor"
          >
            {formatTick(value, xSpan)}
          </text>
        ))}
        <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" fontSize={11} fill="currentColor">
          t (s)
        </text>

        {/* The bounds. A limit is red whether or not it was crossed - it is the limit. */}
        {chart.bounds.map((bound) => (
          <line
            key={`${bound.kind}-${bound.value}`}
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={scaleY(bound.value)}
            y2={scaleY(bound.value)}
            strokeDasharray={bound.kind === "tolerance" ? "2 4" : "7 5"}
            strokeWidth={bound.kind === "tolerance" ? 1 : 1.5}
            vectorEffect="non-scaling-stroke"
            className={bound.kind === "tolerance" ? "stroke-muted-foreground" : "stroke-destructive"}
          />
        ))}

        {/* The signals. */}
        {chart.series.map((series) => {
          const context = series.role === "context"
          if (!context) primaryIndex += 1
          return (
            <path
              key={series.series_id}
              d={path(series)}
              fill="none"
              strokeWidth={context ? 1 : 1.75}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={cn(
                context
                  ? "stroke-muted-foreground opacity-60"
                  : PRIMARY_STROKES[primaryIndex % PRIMARY_STROKES.length]
              )}
            />
          )
        })}

        {/* The sample the reduction picked. */}
        {chart.markers.map((marker) => (
          <g key={`${marker.kind}-${marker.t_s}`}>
            <circle
              cx={scaleX(marker.t_s)}
              cy={scaleY(marker.value)}
              r={4.5}
              className={marker.kind === "breach" ? "fill-destructive" : "fill-primary"}
            />
            <text
              x={Math.min(scaleX(marker.t_s) + 8, WIDTH - PAD.right - 4)}
              y={Math.max(scaleY(marker.value) - 8, PAD.top + 10)}
              textAnchor={scaleX(marker.t_s) > WIDTH * 0.7 ? "end" : "start"}
              fontSize={11}
              fontWeight={600}
              fill="currentColor"
            >
              {marker.label} {marker.value} {chart.unit}
            </text>
          </g>
        ))}

        {/* Axis frame. */}
        <line
          x1={PAD.left}
          x2={PAD.left}
          y1={PAD.top}
          y2={PAD.top + PLOT_H}
          stroke="currentColor"
          strokeOpacity={0.35}
          vectorEffect="non-scaling-stroke"
        />
        <line
          x1={PAD.left}
          x2={WIDTH - PAD.right}
          y1={PAD.top + PLOT_H}
          y2={PAD.top + PLOT_H}
          stroke="currentColor"
          strokeOpacity={0.35}
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <ChartLegend chart={chart} />
    </figure>
  )
}

function ChartLegend({ chart }: { chart: CriterionChart }) {
  let primaryIndex = -1
  return (
    <figcaption className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{chart.y_label}</span>
      {chart.series.map((series) => {
        const context = series.role === "context"
        if (!context) primaryIndex += 1
        return (
          <span key={series.series_id} className="inline-flex items-center gap-1.5">
            <svg width="16" height="8" aria-hidden="true">
              <line
                x1="0"
                x2="16"
                y1="4"
                y2="4"
                strokeWidth={context ? 1 : 2}
                className={cn(
                  context
                    ? "stroke-muted-foreground opacity-60"
                    : PRIMARY_STROKES[primaryIndex % PRIMARY_STROKES.length]
                )}
              />
            </svg>
            {series.label}
          </span>
        )
      })}
      {chart.bounds.map((bound) => (
        <span key={`legend-${bound.value}`} className="inline-flex items-center gap-1.5">
          <svg width="16" height="8" aria-hidden="true">
            <line
              x1="0"
              x2="16"
              y1="4"
              y2="4"
              strokeWidth={1.5}
              strokeDasharray={bound.kind === "tolerance" ? "2 3" : "5 3"}
              className={bound.kind === "tolerance" ? "stroke-muted-foreground" : "stroke-destructive"}
            />
          </svg>
          {bound.label}
        </span>
      ))}
      {chart.spans.some((span) => span.kind === "breach") ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-destructive/25" aria-hidden="true" />
          outside the limit
        </span>
      ) : null}
    </figcaption>
  )
}

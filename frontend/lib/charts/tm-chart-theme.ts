/**
 * Chart.js 4 theme for Test Manager — a 1:1 port of the approved Explore
 * mockup's chart config (explore-tab-mockup.html, D-E2).
 *
 * The factory reads the CSS custom properties at build time
 * (getComputedStyle), so a rebuild on theme change restyles the chart:
 *  - IBM Plex Mono 10px ticks in --ink-3
 *  - y-grid only, in --line-2; no axis borders
 *  - 2px lines, pointRadius 0 with a 3.5px --surface-ringed hover point
 *  - tooltip styled as a TM popover (--surface bg, --line border, mono
 *    fonts, radius 6, mode index / intersect false)
 *  - built-in legend disabled (the panel renders the HTML legend)
 *  - two inline plugins: a dashed --line-strong crosshair, and direct
 *    end-of-line labels + a peak annotation on the first series
 *  - linear epoch-ms x-axis with an en-GB HH:MM:SS tick callback — no
 *    date adapter.
 */

import type { Chart, ChartConfiguration, ChartDataset, Plugin } from "chart.js";

export interface TmPoint {
  x: number; // epoch ms
  y: number;
}

export interface TmSeries {
  label: string;
  /** Direct end-of-line label, e.g. "FL". */
  short: string;
  color: string;
  points: TmPoint[];
}

type TmLineDataset = ChartDataset<"line", TmPoint[]> & { tmShort: string };

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Direct end-of-line labels stay legible up to this many series; beyond it the
 * tmDirectLabels plugin backs off and the HTML legend + index tooltip carry
 * series identity instead.
 */
export const TM_DIRECT_LABEL_MAX = 4;

/** oklch() → sRGB hex via the standard OKLab matrices, channel-clamped to gamut. */
function oklchToHex(lightness: number, chroma: number, hueDeg: number): string {
  const hueRad = (hueDeg * Math.PI) / 180;
  const a = chroma * Math.cos(hueRad);
  const b = chroma * Math.sin(hueRad);
  const l3 = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  const hex = linear
    .map((channel) => {
      const clamped = Math.min(1, Math.max(0, channel));
      const srgb = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(srgb * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("");
  return `#${hex}`;
}

/**
 * N evenly-spaced OKLCH hues at a fixed per-theme lightness/chroma, anchored on
 * the brand series-1 blue (~hue 262). Light theme sits at L 0.48 / C 0.13 (the
 * band of the hand-tuned --chart-s1..s4 on the white surface); dark theme at
 * L 0.68 / C 0.11 (the band of their dark counterparts on #1d1c19). Odd
 * indices additionally lift lightness (+0.15 light / +0.13 dark) so
 * hue-neighbours also differ in tone — tuned against the dataviz palette
 * validator: at 8 series both themes pass chroma floor, CVD separation
 * (worst adjacent ΔE ≥ 9.9), normal-vision floor (≥ 15.4), and ≥ 3:1
 * contrast on their surface. Pure — no DOM — so it is unit-testable in node.
 */
export function tmGeneratedPalette(count: number, dark: boolean): string[] {
  const baseLightness = dark ? 0.68 : 0.48;
  const chroma = dark ? 0.11 : 0.13;
  const alternateLift = dark ? 0.13 : 0.15;
  const colors: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const hue = (262 + (index * 360) / count) % 360;
    const alternate = count > 4 && index % 2 === 1 ? alternateLift : 0;
    colors.push(oklchToHex(baseLightness + alternate, chroma, hue));
  }
  return colors;
}

/**
 * Colors for `count` series. Up to 4 series the validated hand-tuned tokens
 * (--chart-s1..s4, light and dark values in globals.css) are used verbatim;
 * beyond that the palette is generated for the active theme so ANY number of
 * series gets a distinct, surface-legible color. Reads the DOM — call at
 * render/build time and again after a theme change.
 */
export function tmSeriesColors(count: number): string[] {
  const branded = [cssVar("--chart-s1"), cssVar("--chart-s2"), cssVar("--chart-s3"), cssVar("--chart-s4")];
  if (count <= branded.length) return branded.slice(0, Math.max(count, 0));
  return tmGeneratedPalette(count, document.documentElement.classList.contains("dark"));
}

function tmMonoFamily(): string {
  return cssVar("--font-mono") || "'IBM Plex Mono', monospace";
}

export function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/* Dashed crosshair, drawn behind the datasets while the index tooltip is live. */
export const tmCrosshair: Plugin<"line"> = {
  id: "tmCrosshair",
  beforeDatasetsDraw(chart: Chart<"line">) {
    const active = chart.tooltip?.getActiveElements();
    if (!active?.length) return;
    const { top, bottom } = chart.chartArea;
    const x = active[0].element.x;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = cssVar("--line-strong");
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

/*
 * Direct labels at line ends + a peak annotation on the first series.
 * Backs off entirely above TM_DIRECT_LABEL_MAX series — end labels collide at
 * high counts, so the HTML legend + index tooltip carry identity instead.
 */
export const tmDirectLabels: Plugin<"line"> = {
  id: "tmDirectLabels",
  afterDatasetsDraw(chart: Chart<"line">) {
    if (chart.data.datasets.length > TM_DIRECT_LABEL_MAX) return;
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = `600 10px ${tmMonoFamily()}`;
    chart.data.datasets.forEach((rawDataset, datasetIndex) => {
      const dataset = rawDataset as TmLineDataset;
      const points = chart.getDatasetMeta(datasetIndex).data;
      const last = points[points.length - 1];
      if (!last) return;
      ctx.fillStyle = String(dataset.borderColor);
      ctx.textAlign = "left";
      ctx.fillText(dataset.tmShort, last.x + 8, last.y + 3);
    });

    // Peak annotation: the maximum of the first series, surface-ringed.
    const first = chart.data.datasets[0] as TmLineDataset | undefined;
    if (!first || first.data.length === 0) {
      ctx.restore();
      return;
    }
    let peakIndex = 0;
    first.data.forEach((point, index) => {
      if (point.y > first.data[peakIndex].y) peakIndex = index;
    });
    const element = chart.getDatasetMeta(0).data[peakIndex];
    if (!element) {
      ctx.restore();
      return;
    }
    const color = String(first.borderColor);
    ctx.beginPath();
    ctx.arc(element.x, element.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = cssVar("--surface");
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    const peak = first.data[peakIndex];
    ctx.fillText(`${peak.y.toFixed(1)} · ${formatClockTime(peak.x)}`, element.x, element.y - 10);
    ctx.restore();
  },
};

function tmDataset(series: TmSeries): TmLineDataset {
  return {
    label: series.label,
    tmShort: series.short,
    data: series.points,
    borderColor: series.color,
    borderWidth: 2,
    tension: 0,
    fill: false,
    pointRadius: 0,
    pointHoverRadius: 3.5,
    pointHoverBackgroundColor: series.color,
    pointHoverBorderColor: cssVar("--surface"),
    pointHoverBorderWidth: 2,
  };
}

/**
 * Build the full line-chart configuration for the given series. Colors and
 * fonts are read from the CSS tokens at call time — call again after a theme
 * change and replace the chart.
 */
export function tmChartConfig(series: TmSeries[]): ChartConfiguration<"line", TmPoint[]> {
  const fontMono = { family: tmMonoFamily(), size: 10 };
  return {
    type: "line",
    data: { datasets: series.map(tmDataset) },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      // The right gutter exists for the direct end-of-line labels; when they
      // back off (> TM_DIRECT_LABEL_MAX series) reclaim it for the plot.
      layout: {
        padding: { right: series.length > TM_DIRECT_LABEL_MAX ? 16 : 88, top: 26, left: 2 },
      },
      interaction: { mode: "index", intersect: false },
      scales: {
        x: {
          type: "linear",
          grid: { display: false },
          border: { display: false },
          ticks: {
            font: fontMono,
            color: cssVar("--ink-3"),
            maxTicksLimit: 6,
            maxRotation: 0,
            autoSkipPadding: 24,
            callback: (value) => formatClockTime(Number(value)),
          },
        },
        y: {
          grid: { color: cssVar("--line-2"), drawTicks: false },
          border: { display: false },
          ticks: {
            font: fontMono,
            color: cssVar("--ink-3"),
            padding: 8,
          },
        },
      },
      plugins: {
        legend: { display: false }, // the styled HTML legend above the canvas
        tooltip: {
          backgroundColor: cssVar("--surface"),
          borderColor: cssVar("--line"),
          borderWidth: 1,
          titleColor: cssVar("--ink-3"),
          titleFont: { ...fontMono, size: 9 },
          bodyColor: cssVar("--ink"),
          bodyFont: fontMono,
          padding: 10,
          cornerRadius: 6,
          displayColors: true,
          boxWidth: 8,
          boxHeight: 8,
          boxPadding: 4,
          caretSize: 0,
          callbacks: {
            title: (items) => {
              const x: unknown = items[0]?.parsed.x;
              return typeof x === "number" ? formatClockTime(x) : "";
            },
            label: (item) => {
              const y: unknown = item.parsed.y;
              return ` ${item.dataset.label}  ${typeof y === "number" ? y.toFixed(1) : "—"}`;
            },
          },
        },
      },
    },
    plugins: [tmCrosshair, tmDirectLabels],
  };
}

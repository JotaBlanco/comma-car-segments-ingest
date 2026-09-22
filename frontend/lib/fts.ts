"use client";

/**
 * The seam to the Flight Test Station.
 *
 * A configured URL shows the panel; no URL hides it. `app/layout.tsx` resolves
 * it server-side from `GET /api/v1/integrations/fts-url` and `FtsConfigProvider`
 * calls the setter below, so `next build` bakes no host into the image.
 *
 * The station's entry contract is the query string — `?run=&signal=&t=&sel=`
 * (`flight-test-station/frontend/src/app/params.ts`) — so a plain link opens a
 * named run with named signals, and a tab does it as well as a frame. A run id
 * and a signal name are identifiers, not credentials; the token never rides
 * here, it arrives over postMessage from the panel.
 */

let configuredUrl: string | null = null;
let configuredOrigin: string | null = null;

/** Take the station URL and origin the server resolved. Empty means none. */
export function setFtsConfig(
  url: string | null | undefined,
  origin: string | null | undefined,
): void {
  const base = (url ?? "").trim();
  const from = (origin ?? "").trim();
  configuredUrl = base.length > 0 ? base : null;
  configuredOrigin = configuredUrl !== null && from.length > 0 ? from : null;
}

/** True when a station URL reached this process. */
export function ftsConfigured(): boolean {
  return configuredUrl !== null;
}

/**
 * The station's origin, for the `targetOrigin` of every posted token.
 *
 * Null frames nothing: a token posted to `"*"` goes to whatever page the frame
 * navigated to.
 */
export function ftsOrigin(): string | null {
  return configuredOrigin;
}

/**
 * The longest entry link built before the signal list is dropped.
 *
 * A truncated `signal=` would open the WRONG signal rather than none, so an
 * over-long list goes whole and the panel says so.
 */
export const MAX_ENTRY_URL_CHARS = 2_000;

export interface FtsEntry {
  url: string;
  /** True when the pick did not fit, so this opens the run alone. */
  signalsDropped: boolean;
}

function build(
  runId: string,
  signals: readonly string[],
  extra: readonly [string, string][],
): FtsEntry | null {
  if (configuredUrl === null) return null;
  const query = new URLSearchParams(extra.map(([k, v]) => [k, v]));
  // No run opens the empty station: a workbook picks its run from the Test Manager.
  if (runId.length > 0) query.set("run", runId);
  const withRun = `${configuredUrl}?${query.toString()}`;
  for (const name of signals) query.append("signal", name);
  const full = `${configuredUrl}?${query.toString()}`;
  if (full.length <= MAX_ENTRY_URL_CHARS)
    return { url: full, signalsDropped: false };
  return { url: withRun, signalsDropped: signals.length > 0 };
}

/** The link a tab opens: the run, and the signals a person picked. */
export function ftsTabUrl(
  runId: string,
  signals: readonly string[],
): FtsEntry | null {
  return build(runId, signals, []);
}

/**
 * The link that opens a snippet where it happened: the run, the signal it concerns,
 * the playhead at its start and the period marked (`sel=`).
 */
export function ftsSnippetUrl(
  runId: string,
  signal: string | null,
  frame: { t0_ms: number; t1_ms: number } | null,
): FtsEntry | null {
  const extra: [string, string][] = [];
  if (frame !== null) {
    extra.push(["t", String(frame.t0_ms)]);
    extra.push(["sel", `${frame.t0_ms},${Math.max(frame.t1_ms, frame.t0_ms + 1)}`]);
  }
  return build(runId, signal === null ? [] : [signal], extra);
}

/**
 * The link the iframe loads: the same entry, plus what the frame needs.
 *
 * `parentOrigin` names THIS page. The station is framed two deep — Portal
 * frames the Test Manager, the Test Manager frames the station — so the
 * Portal's plugin SDK cannot reach it and it asks its parent for a token.
 */
export function ftsFrameUrl(
  runId: string,
  signals: readonly string[],
  parentOrigin: string,
): FtsEntry | null {
  return build(runId, signals, [
    ["isIframe", "true"],
    ["parentOrigin", parentOrigin],
  ]);
}

/**
 * Open an entry link in a new tab.
 *
 * No await in front of it: a browser blocks a `window.open` that a fetch
 * answer triggers. `noopener` keeps the tab from reaching back.
 */
export function openFts(entry: FtsEntry | null): void {
  if (entry === null) return;
  window.open(entry.url, "_blank", "noopener");
}

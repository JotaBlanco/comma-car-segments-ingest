/**
 * Caret pixel position inside a <textarea>, via the standard mirror-div
 * technique: a hidden div replicates the textarea's text metrics and its
 * content up to the caret, then a marker span is measured. The string
 * mechanics (`mirrorParts`) are pure and unit-tested in the node environment;
 * `measureCaret` is the thin DOM half (jsdom measures everything as 0, which
 * callers treat as "anchor at the top-left").
 */

export interface MirrorParts {
  /** Everything before the caret — rendered as plain text in the mirror. */
  before: string;
  /** The marker span's content — must occupy real width to be measurable. */
  marker: string;
}

/** Split `value` at `caret` (clamped) into the mirror's text + marker char. */
export function mirrorParts(value: string, caret: number): MirrorParts {
  const at = Math.max(0, Math.min(caret, value.length));
  const next = value.charAt(at);
  return {
    before: value.slice(0, at),
    // At end-of-text or end-of-line the real next char has no width (or does
    // not exist) — a placeholder keeps the marker's offsetLeft honest.
    marker: next === "" || next === "\n" ? "." : next,
  };
}

/** Styles that affect text metrics — copied from the textarea to the mirror. */
const MIRROR_STYLES = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "textTransform",
  "textIndent",
  "lineHeight",
  "tabSize",
  "boxSizing",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
] as const;

export interface CaretCoords {
  /** Offset from the textarea's top edge, scroll already subtracted. */
  top: number;
  /** Offset from the textarea's left edge, scroll already subtracted. */
  left: number;
  /** Measured line height — 0 where layout is not implemented (jsdom). */
  lineHeight: number;
}

/** Measure the caret's position inside `textarea` at index `caret`. */
export function measureCaret(textarea: HTMLTextAreaElement, caret: number): CaretCoords {
  const doc = textarea.ownerDocument;
  const mirror = doc.createElement("div");
  mirror.style.position = "absolute";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.visibility = "hidden";
  // The editor sets wrap="off", so lines never soft-wrap: `pre` alone
  // reproduces the layout and the mirror needs no fixed width.
  mirror.style.whiteSpace = "pre";
  const computed = doc.defaultView?.getComputedStyle(textarea);
  if (computed !== undefined && computed !== null) {
    for (const prop of MIRROR_STYLES) mirror.style[prop] = computed[prop];
  }

  const parts = mirrorParts(textarea.value, caret);
  mirror.appendChild(doc.createTextNode(parts.before));
  const marker = doc.createElement("span");
  marker.textContent = parts.marker;
  mirror.appendChild(marker);

  doc.body.appendChild(mirror);
  const coords = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    lineHeight: marker.offsetHeight,
  };
  mirror.remove();
  return coords;
}

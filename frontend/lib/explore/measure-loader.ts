"use client";

/**
 * QuixLab's Explorer, loaded as it ships: six plain scripts and one stylesheet
 * copied from `quixlab/server/static` into `public/explore`, in QuixLab's own
 * order. They attach `window.QM`, `window.MeasureView` and
 * `window.MeasureLake`, and the view is mounted through `MeasureView.mount`
 * exactly as QuixLab's Explore node mounts it. Loaded once per page.
 */

export const EXPLORE_STYLES = "/explore/measure.css";
export const EXPLORE_SCRIPTS = [
  "/explore/icons.js",
  "/explore/measure-render.js",
  "/explore/measure-view.js",
  "/explore/measure-tree.js",
  "/explore/measure-nav.js",
  "/explore/measure-lake.js",
] as const;

export interface MeasureController {
  load(layout: unknown): void;
  serialize(): unknown;
  destroy(): void;
  setTheme(theme: string): void;
  /** Draw the tree; with `_treeRoot` cleared first, it asks the provider afresh. */
  renderTree(): void;
  _treeRoot?: unknown;
  state: { table?: string };
}

export interface MeasureConfig {
  title?: string;
  table?: string | null;
  provider: unknown;
  theme?: string;
  exploreOnly?: boolean;
  compact?: boolean;
  onChange?(layout: unknown): void;
  onClose?(): void;
}

declare global {
  interface Window {
    MeasureView?: { mount(host: HTMLElement, cfg: MeasureConfig): MeasureController };
    MeasureLake?: { provider(getTable: () => string): unknown; pick(): string };
    qlToast?: (message: string, kind?: string) => void;
    /** The Test Manager's viewer token, for the provider's calls (`measure-lake.js`). */
    __tmLakeHeaders?: () => Record<string, string>;
  }
}

function once(doc: Document, tag: "link" | "script", url: string): Promise<void> {
  const key = tag === "link" ? `link[data-explore="${url}"]` : `script[data-explore="${url}"]`;
  const existing = doc.querySelector<HTMLElement>(key);
  if (existing !== null) {
    if (existing.dataset.loaded === "1") return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener("error", () => reject(new Error(`could not load ${url}`)), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const el = doc.createElement(tag);
    el.dataset.explore = url;
    if (el instanceof HTMLLinkElement) {
      el.rel = "stylesheet";
      el.href = url;
    } else if (el instanceof HTMLScriptElement) {
      el.src = url;
      el.async = false;
    }
    el.addEventListener("load", () => {
      el.dataset.loaded = "1";
      resolve();
    });
    el.addEventListener("error", () => reject(new Error(`could not load ${url}`)));
    doc.head.appendChild(el);
  });
}

/** Load the stylesheet and the scripts, in order, once; resolves when the view can mount. */
export async function ensureMeasureLoaded(doc: Document = document): Promise<void> {
  await once(doc, "link", EXPLORE_STYLES);
  for (const url of EXPLORE_SCRIPTS) await once(doc, "script", url);
  const w = doc.defaultView;
  if (!w?.MeasureView || !w.MeasureLake) throw new Error("the Explorer did not attach itself");
}

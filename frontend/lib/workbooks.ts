"use client";

import { useSyncExternalStore } from "react";

/**
 * Workbooks: saved Flight Test Station dashboards the Test Manager keeps.
 *
 * A workbook is a name and a layout. The layout is the station's own dashboard
 * model (`flight-test-station/frontend/src/layout/dashboard.ts`), held here as
 * opaque JSON: the station normalises it on the way in and hands every change
 * back over postMessage, so this module never interprets a cell. The store is
 * the saved-search store's shape: one `localStorage` key, read through
 * `useSyncExternalStore`, a refused storage falls back to memory for the tab.
 */

export interface Workbook {
  id: string;
  name: string;
  /** The station's layout items, as it last reported them. Empty means "the standard". */
  layout: readonly unknown[];
  /** The test runs picked for this workbook, in pick order: the session dropdown. */
  sessions: readonly string[];
  /** Epoch ms. */
  created_at: number;
  updated_at: number;
}

export const WORKBOOKS_KEY = "tm-workbooks";
export const WORKBOOKS_VERSION = 1;
export const MAX_WORKBOOKS = 50;
export const MAX_WORKBOOK_NAME = 60;

const EMPTY: readonly Workbook[] = [];
let snapshot: readonly Workbook[] | undefined;
let memory: readonly Workbook[] = EMPTY;
let volatile = false;
const listeners = new Set<() => void>();

function isWorkbook(value: unknown): value is Workbook {
  if (typeof value !== "object" || value === null) return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.name === "string" &&
    Array.isArray(w.layout) &&
    (w.sessions === undefined || Array.isArray(w.sessions)) &&
    typeof w.created_at === "number" &&
    typeof w.updated_at === "number"
  );
}

function read(): readonly Workbook[] {
  if (typeof window === "undefined") return EMPTY;
  if (volatile) return memory;
  try {
    const raw = window.localStorage.getItem(WORKBOOKS_KEY);
    if (raw === null) return EMPTY;
    const stored = JSON.parse(raw) as { v: number; workbooks: unknown };
    if (stored.v !== WORKBOOKS_VERSION || !Array.isArray(stored.workbooks)) return EMPTY;
    return stored.workbooks.filter(isWorkbook).map((w) => ({ ...w, sessions: w.sessions ?? [] }));
  } catch {
    return memory;
  }
}

function commit(workbooks: readonly Workbook[]): void {
  memory = workbooks;
  snapshot = workbooks;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(
        WORKBOOKS_KEY,
        JSON.stringify({ v: WORKBOOKS_VERSION, workbooks }),
      );
      volatile = false;
    } catch {
      volatile = true;
    }
  }
  for (const l of listeners) l();
}

function getSnapshot(): readonly Workbook[] {
  if (snapshot === undefined) snapshot = read();
  return snapshot;
}

function getServerSnapshot(): readonly Workbook[] {
  return EMPTY;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `w-${Math.random().toString(36).slice(2, 10)}`;
}

/** Every workbook, newest change first. */
export function useWorkbooks(): readonly Workbook[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

export function useWorkbook(id: string): Workbook | null {
  const all = useWorkbooks();
  return all.find((w) => w.id === id) ?? null;
}

export function listWorkbooks(): readonly Workbook[] {
  return getSnapshot();
}

/** A blank workbook: the station fills it with its standard layout. Returns it, or null when full. */
export function createWorkbook(name: string): Workbook | null {
  const all = getSnapshot();
  if (all.length >= MAX_WORKBOOKS) return null;
  const now = Date.now();
  const w: Workbook = {
    id: newId(),
    name: cleanName(name),
    layout: [],
    sessions: [],
    created_at: now,
    updated_at: now,
  };
  commit([w, ...all]);
  return w;
}

export function renameWorkbook(id: string, name: string): void {
  const all = getSnapshot();
  if (!all.some((w) => w.id === id)) return;
  commit(all.map((w) => (w.id === id ? { ...w, name: cleanName(name), updated_at: Date.now() } : w)));
}

export function deleteWorkbook(id: string): void {
  const all = getSnapshot();
  if (!all.some((w) => w.id === id)) return;
  commit(all.filter((w) => w.id !== id));
}

/** The station reported a change; keep it. Anything but a list is ignored. */
export function setWorkbookLayout(id: string, layout: unknown): void {
  if (!Array.isArray(layout)) return;
  const all = getSnapshot();
  const w = all.find((x) => x.id === id);
  if (!w || JSON.stringify(w.layout) === JSON.stringify(layout)) return;
  const next = { ...w, layout: layout as readonly unknown[], updated_at: Date.now() };
  commit([next, ...all.filter((x) => x.id !== id)]);
}

/** The runs a workbook opens on. A run opened from a shortcut joins the list on arrival. */
export function setWorkbookSessions(id: string, sessions: readonly string[]): void {
  const all = getSnapshot();
  const w = all.find((x) => x.id === id);
  if (!w) return;
  const next = [...new Set(sessions.filter((s) => s.length > 0))];
  if (next.length === w.sessions.length && next.every((s, i) => s === w.sessions[i])) return;
  commit(all.map((x) => (x.id === id ? { ...x, sessions: next, updated_at: Date.now() } : x)));
}

export function cleanName(name: string): string {
  const trimmed = name.trim().slice(0, MAX_WORKBOOK_NAME);
  return trimmed.length > 0 ? trimmed : "Untitled workbook";
}

/** For tests: drop the cached snapshot so the next read hits storage. */
export function resetWorkbooksForTests(): void {
  snapshot = undefined;
  memory = EMPTY;
  volatile = false;
}

/** The workbook page for a run, and optionally the signal and period an issue names. */
export function workbookHref(
  id: string,
  ctx: {
    run?: string | null;
    signals?: readonly string[];
    frame?: { t0_ms: number; t1_ms: number } | null;
    /** The issue's lake snippet id, ticked on arrival. */
    issue?: number | null;
  } = {},
): string {
  const q = new URLSearchParams();
  if (ctx.run) q.set("run", ctx.run);
  for (const s of ctx.signals ?? []) q.append("signal", s);
  if (ctx.frame) {
    q.set("t", String(ctx.frame.t0_ms));
    q.set("sel", `${ctx.frame.t0_ms},${Math.max(ctx.frame.t1_ms, ctx.frame.t0_ms + 1)}`);
  }
  if (ctx.issue) q.set("issue", String(ctx.issue));
  const query = q.toString();
  return `/workbooks/${encodeURIComponent(id)}${query ? `?${query}` : ""}`;
}

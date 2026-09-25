import { api } from "./client";

/**
 * A run's QuixLab notebooks, and the lab of this viewer's own that opens each.
 *
 * The product used to send everybody to ONE shared QuixLab named by
 * `TM_QUIXLAB_URL`. Now a run holds any number of notebooks — each a file in a
 * blob folder of its own — and opening one clones the workspace's QuixLab into
 * a deployment of the viewer's own on that folder. `api/quixlab_provision.py`
 * carries the reasons.
 *
 * Every call but the list runs as the viewer: `client.ts` adds the
 * `x-portal-token` header, and the API creates nothing without it.
 */
export interface RunQuixLab {
  id: string;
  name: string;
  /** The Portal's own word, passed through. See `running()`. */
  status: string;
  url: string;
  /** The `blob://` pointer the lab opens, naming the notebook's own folder. */
  notebook: string;
  /** True only when THIS call made the deployment. */
  created: boolean;
}

export interface Notebook {
  notebook_id: string;
  run_id: string;
  name: string;
  /** The definition this notebook drafts an implementation of; null for a plain analysis. */
  definition_id?: string | null;
  created_by: string;
  created_at: string;
  /** The last Save and Close; null until the first. */
  saved_at: string | null;
  /** This viewer's lab on it, when the Portal knows one. Null for a notebook never opened here. */
  lab: RunQuixLab | null;
}

/**
 * The statuses that mean "a browser can open it now".
 *
 * The Portal spells a healthy service `Running`. Everything else — `Building`,
 * `Queued`, `Starting`, `Stopped` — means the address exists but nothing
 * answers on it yet, which is why the panel waits rather than framing a 502.
 */
export function running(lab: RunQuixLab): boolean {
  return lab.status.trim().toLowerCase() === "running";
}

function path(runId: string, notebookId?: string): string {
  const base = `/test-runs/${encodeURIComponent(runId)}/notebooks`;
  return notebookId === undefined ? base : `${base}/${encodeURIComponent(notebookId)}`;
}

/** The run's notebooks, oldest first, each with this viewer's lab when there is one. */
export function listNotebooks(runId: string): Promise<Notebook[]> {
  return api.get<Notebook[]>(path(runId));
}

/** Every notebook of every run, newest first, each with this viewer's lab: the Workflows page. */
export function listAllNotebooks(): Promise<Notebook[]> {
  return api.get<Notebook[]>("/notebooks");
}

/**
 * A new notebook on this run, its starter file written, and this viewer's lab started on it.
 * With `definitionId` the starter is an implementation DRAFT of that definition on this run.
 */
export function createNotebook(runId: string, name?: string, definitionId?: string): Promise<Notebook> {
  const body: { name?: string; definition_id?: string } = {};
  if (name !== undefined) body.name = name;
  if (definitionId !== undefined) body.definition_id = definitionId;
  return api.post<Notebook>(path(runId), body);
}

/** Start (or make) this viewer's lab on a saved notebook. The file is never written over. */
export function openNotebook(runId: string, notebookId: string): Promise<Notebook> {
  return api.post<Notebook>(`${path(runId, notebookId)}/open`, {});
}

/** This viewer's lab on the notebook. It makes nothing, so a poll may call it. */
export function getNotebookLab(runId: string, notebookId: string): Promise<RunQuixLab> {
  return api.get<RunQuixLab>(`${path(runId, notebookId)}/lab`);
}

/**
 * Save and Close: the notebook confirmed on disk and its save recorded, then the lab stopped.
 *
 * The lab is stopped, not removed, so the next `openNotebook` starts it again on the
 * same work in seconds.
 */
export function closeNotebook(runId: string, notebookId: string): Promise<Notebook> {
  return api.post<Notebook>(`${path(runId, notebookId)}/close`, {});
}

/** Stop this viewer's lab on the notebook and record nothing: the list's Stop control. */
export function stopNotebook(runId: string, notebookId: string): Promise<Notebook> {
  return api.post<Notebook>(`${path(runId, notebookId)}/stop`, {});
}

/** Forget a notebook: this viewer's lab on it removed, then the row. */
export function deleteNotebook(runId: string, notebookId: string): Promise<void> {
  return api.deleteVoid(path(runId, notebookId), {});
}

/** What Accept on a draft notebook would store: exactly these bytes, under this name. */
export interface DraftImplementation {
  definition_id: string;
  filename: string;
  code: string;
  sha256: string;
}

/** The definition's implementation pointer, as the upload route answers it. */
export interface StoredImplementation {
  filename: string;
  sha256: string;
  size_bytes: number;
  entrypoint: string;
}

/**
 * The draft cell's generated code, lifted out of the notebook as the module Accept stores.
 * 409 `not_a_draft`, 422 `draft_not_generated` before the cell ran, 422 `draft_invalid`.
 */
export function previewDraft(runId: string, notebookId: string): Promise<DraftImplementation> {
  return api.get<DraftImplementation>(`${path(runId, notebookId)}/draft`);
}

/**
 * Store the previewed module as the definition's implementation.
 * `sha256` is the preview's: 409 `draft_changed` when the cell changed since.
 */
export function acceptDraft(
  runId: string,
  notebookId: string,
  sha256: string,
): Promise<StoredImplementation> {
  return api.post<StoredImplementation>(`${path(runId, notebookId)}/draft/accept`, { sha256 });
}

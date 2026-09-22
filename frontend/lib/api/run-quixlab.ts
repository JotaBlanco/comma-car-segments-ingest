import { api } from "./client";

/**
 * One person's QuixLab for one run.
 *
 * The product used to send everybody to ONE shared QuixLab named by
 * `TM_QUIXLAB_URL`. These three calls replace that: the API clones the
 * workspace's QuixLab into a deployment of the viewer's own, opened on a
 * notebook written into the run's own folder. `api/quixlab_provision.py`
 * carries the reasons.
 *
 * Every call runs as the viewer: `client.ts` adds the `x-portal-token` header,
 * and the API creates nothing without it.
 */
export interface RunQuixLab {
  id: string;
  name: string;
  /** The Portal's own word, passed through. See `running()`. */
  status: string;
  url: string;
  /** The `blob://` pointer the lab opens, naming the run's own folder. */
  notebook: string;
  /** True only when THIS call made the deployment. */
  created: boolean;
}

/**
 * The statuses that mean "a browser can open it now".
 *
 * The Portal spells a healthy service `Running`. Everything else — `Building`,
 * `Queued`, `Starting`, `Stopped` — means the address exists but nothing
 * answers on it yet, which is why the launch control waits rather than opening
 * a tab on a 502.
 */
export function running(lab: RunQuixLab): boolean {
  return lab.status.trim().toLowerCase() === "running";
}

function path(runId: string): string {
  return `/test-runs/${encodeURIComponent(runId)}/quixlab`;
}

/** Make this viewer's lab for this run, or answer the one they have. */
export function createRunQuixLab(runId: string): Promise<RunQuixLab> {
  return api.post<RunQuixLab>(path(runId), {});
}

/** This viewer's lab for this run. It makes nothing, so a poll may call it. */
export function getRunQuixLab(runId: string): Promise<RunQuixLab> {
  return api.get<RunQuixLab>(path(runId));
}

/** Remove this viewer's lab for this run. */
export function deleteRunQuixLab(runId: string): Promise<void> {
  return api.deleteVoid(path(runId), {});
}

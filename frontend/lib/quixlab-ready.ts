"use client";

/**
 * Waiting for a lab that the Portal calls Running but that does not answer yet.
 *
 * A deployment reads `Running` the moment its pod is scheduled; the QuixLab
 * server inside takes longer, and until it listens the ingress answers every
 * request with its own error page. A frame set to the lab's address in that
 * window shows "Bad Request" and never refreshes itself, and a tab sent there
 * shows the same.
 *
 * QuixLab serves `/healthz` unauthenticated, with a wildcard CORS header for
 * exactly this caller (`quixlab/src/quixlab/server/embed.py`), so a host on
 * another origin can ask it plainly. A lab built from an older image answers
 * the probe without the header, which a browser reports as a network error;
 * that reads as "not yet" here, and the wait runs out rather than hangs.
 */

/** How often the probe is asked. */
export const READY_POLL_MS = 2_000;

/**
 * How long a lab is waited for before the caller proceeds regardless.
 *
 * Short on purpose. A lab built from an image without the CORS header on `/healthz` never
 * answers this probe at all, and a person cannot tell that from a lab still starting; so
 * the probe buys a few seconds of grace for the common case, and the frame's own watchdog
 * (`FRAME_PATIENCE_MS`, reloading until the lab speaks) covers the rest.
 */
export const READY_GIVE_UP_MS = 15_000;

export interface ReadyDeps {
  probe(url: string): Promise<boolean>;
  wait(ms: number): Promise<void>;
  now(): number;
}

/** The liveness probe of the lab at `url`. */
export function healthUrl(url: string): string {
  return `${new URL(url).origin}/healthz`;
}

async function probe(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { mode: "cors", cache: "no-store", credentials: "omit" });
    return response.ok;
  } catch {
    // A network error, or a probe without the CORS header: not answering yet.
    return false;
  }
}

const LIVE: ReadyDeps = {
  probe,
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/**
 * True once the lab at `url` answers its probe, false when the patience ran out.
 *
 * A false is not a failure to act on: the caller proceeds to frame or open the
 * lab, and the frame's own watchdog keeps reloading until QuixLab speaks.
 */
export async function waitForLab(url: string, deps: ReadyDeps = LIVE): Promise<boolean> {
  const target = healthUrl(url);
  const giveUpAt = deps.now() + READY_GIVE_UP_MS;
  for (;;) {
    if (await deps.probe(target)) return true;
    if (deps.now() >= giveUpAt) return false;
    await deps.wait(READY_POLL_MS);
  }
}

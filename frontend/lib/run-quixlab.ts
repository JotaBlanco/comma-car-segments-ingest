"use client";

import {
  createRunQuixLab,
  getRunQuixLab,
  running,
  type RunQuixLab,
} from "@/lib/api/run-quixlab";

/**
 * Launching one person's QuixLab for one run, without losing the click.
 *
 * **Why a tab is claimed before any await.** A browser blocks a `window.open`
 * that a fetch answer triggers, because the user gesture is over by then
 * (`lib/quixlab.ts` states the same rule for the old shared link). Creating a
 * lab is a deployment create and a wait for it to build, so there is no way to
 * have the address in hand on the click. The tab is therefore opened EMPTY on
 * the click and redirected once the lab answers.
 *
 * **Why not `noopener`.** `window.open(url, name, "noopener")` returns null by
 * design — the caller is not allowed to keep a handle — and a null handle
 * cannot be redirected. So the tab is opened without it and the child's
 * back-reference is severed by hand instead, which leaves the same protection
 * against reverse tabnabbing with a handle we can still use.
 *
 * **Why it waits rather than redirecting at once.** A freshly created
 * deployment answers `Building`: the address exists and nothing serves on it.
 * Sending a person there shows them a 502 that never refreshes itself.
 */

/** How often the lab is asked whether it is up. */
export const POLL_MS = 2_000;

/** How long a build is waited for before the tab offers a plain link instead. */
export const GIVE_UP_MS = 5 * 60_000;

/** The claimed tab, as the launcher uses it. A test hands in its own. */
export interface LaunchTab {
  /** Show a line of progress. */
  say(message: string): void;
  /** Send the tab to the lab. */
  go(url: string): void;
  /** Offer the address as a link, for a wait that outlasted the patience. */
  offer(url: string, message: string): void;
  /** False once the person closed it — every wait stops there. */
  alive(): boolean;
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function page(body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>QuixLab</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;
height:100vh;background:#0f1115;color:#e6e8ee}div{text-align:center;max-width:32rem;padding:2rem}
a{color:#7aa2f7}</style><div>${body}</div>`;
}

/**
 * Claim a tab on the click. Null when the browser refused to open one.
 *
 * `opener` is a plain window handle, so the blank document is same-origin and
 * this may write to it. Once it navigates to the lab it is cross-origin and
 * every write below throws, which is why each one is guarded: the tab has
 * arrived, and a throw at that point is not a failure.
 */
export function claimTab(open: Window["open"] = window.open.bind(window)): LaunchTab | null {
  const win = open("", "_blank");
  if (!win) return null;
  try {
    win.opener = null;
  } catch {
    /* already severed, or the browser did it for us */
  }
  const write = (body: string) => {
    try {
      win.document.open();
      win.document.write(page(body));
      win.document.close();
    } catch {
      /* the tab navigated away, or was closed */
    }
  };
  return {
    say: (message) => write(`<p>${escape(message)}</p>`),
    go: (url) => {
      try {
        win.location.replace(url);
      } catch {
        /* closed mid-flight */
      }
    },
    offer: (url, message) =>
      write(
        `<p>${escape(message)}</p><p><a href="${escape(url)}">${escape(url)}</a></p>`,
      ),
    alive: () => !win.closed,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface LaunchDeps {
  create(runId: string): Promise<RunQuixLab>;
  read(runId: string): Promise<RunQuixLab>;
  wait(ms: number): Promise<void>;
  now(): number;
}

const LIVE: LaunchDeps = {
  create: createRunQuixLab,
  read: getRunQuixLab,
  wait: sleep,
  now: () => Date.now(),
};

/**
 * Make this viewer's lab for this run and send the claimed tab to it.
 *
 * It resolves with the lab whatever happened to the tab, so a caller can
 * report the outcome; it rejects only when the lab could not be made, and the
 * caller then closes the tab and shows the reason.
 */
export async function launchRunQuixLab(
  runId: string,
  tab: LaunchTab,
  deps: LaunchDeps = LIVE,
): Promise<RunQuixLab> {
  tab.say("Setting up your QuixLab for this run…");
  let lab = await deps.create(runId);
  const giveUpAt = deps.now() + GIVE_UP_MS;

  while (!running(lab) && tab.alive() && deps.now() < giveUpAt) {
    tab.say(`Starting your QuixLab… (${lab.status.trim() || "queued"})`);
    await deps.wait(POLL_MS);
    lab = await deps.read(runId);
  }

  if (!tab.alive()) return lab;
  if (running(lab)) {
    tab.go(lab.url);
    return lab;
  }
  // The build outlasted the wait. A link is honest; a redirect into a 502 that
  // never refreshes itself is not.
  tab.offer(lab.url, "Your QuixLab is still starting. Open it here when it is ready:");
  return lab;
}

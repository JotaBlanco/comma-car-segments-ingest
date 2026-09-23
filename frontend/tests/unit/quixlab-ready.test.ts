import { describe, expect, it } from "vitest";
import { healthUrl, READY_GIVE_UP_MS, READY_POLL_MS, waitForLab, type ReadyDeps } from "@/lib/quixlab-ready";

/**
 * Waiting for a lab the Portal calls Running but that does not answer yet.
 *
 * The rule worth holding: a probe that errors (the ingress page, or a lab
 * built before /healthz carried a CORS header) is "not yet", never a crash,
 * and the wait ends on its own rather than hanging a click forever.
 */

const LAB = "https://tm-lab-abc.dev.quix.io";

function deps(answers: boolean[], clock = { at: 0 }): ReadyDeps & { asked: string[] } {
  const queue = [...answers];
  const out = {
    asked: [] as string[],
    probe: (url: string) => {
      out.asked.push(url);
      return Promise.resolve(queue.length > 0 ? queue.shift()! : false);
    },
    wait: (ms: number) => {
      clock.at += ms;
      return Promise.resolve();
    },
    now: () => clock.at,
  };
  return out;
}

describe("healthUrl", () => {
  it("probes the lab's origin, whatever path or query the address carried", () => {
    expect(healthUrl(`${LAB}/some/page?isIframe=true`)).toBe(`${LAB}/healthz`);
  });
});

describe("waitForLab", () => {
  it("answers at once when the lab already listens", async () => {
    const d = deps([true]);

    expect(await waitForLab(LAB, d)).toBe(true);
    expect(d.asked).toEqual([`${LAB}/healthz`]);
  });

  it("keeps asking every READY_POLL_MS until the lab answers", async () => {
    const clock = { at: 0 };
    const d = deps([false, false, true], clock);

    expect(await waitForLab(LAB, d)).toBe(true);
    expect(d.asked).toHaveLength(3);
    expect(clock.at).toBe(2 * READY_POLL_MS);
  });

  it("gives up after READY_GIVE_UP_MS and says so, rather than hanging the click", async () => {
    const clock = { at: 0 };
    const d = deps([], clock);

    expect(await waitForLab(LAB, d)).toBe(false);
    expect(clock.at).toBeGreaterThanOrEqual(READY_GIVE_UP_MS);
  });
});

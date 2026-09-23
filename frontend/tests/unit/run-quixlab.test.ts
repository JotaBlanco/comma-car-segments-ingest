import { describe, expect, it, vi } from "vitest";
import { running, type Notebook, type RunQuixLab } from "@/lib/api/run-quixlab";
import { GIVE_UP_MS, launchRunQuixLab, type LaunchDeps, type LaunchTab } from "@/lib/run-quixlab";

/**
 * Launching one person's QuixLab for one run.
 *
 * The two rules worth holding: a person is never sent to a deployment that is
 * still building (they would land on a 502 that never refreshes itself), and
 * nothing keeps polling a tab that was closed.
 */

function lab(status: string): RunQuixLab {
  return {
    id: "dep-lab",
    name: "tm-lab-a",
    status,
    url: "https://tm-lab-a.dev.quix.io",
    notebook: "blob://ws/quixlab-runs/r1/nb-1/analysis.py",
    created: status === "Building",
  };
}

function notebook(id: string, current: RunQuixLab | null = null): Notebook {
  return {
    notebook_id: id,
    run_id: "r1",
    name: id,
    created_by: "Ana",
    created_at: "2026-09-22T09:00:00Z",
    saved_at: null,
    lab: current,
  };
}

function fakeTab(): LaunchTab & { said: string[]; went: string[]; offered: string[]; open: boolean } {
  const state = {
    said: [] as string[],
    went: [] as string[],
    offered: [] as string[],
    open: true,
    say(message: string) {
      state.said.push(message);
    },
    go(url: string) {
      state.went.push(url);
    },
    offer(url: string, message: string) {
      state.offered.push(`${message} ${url}`);
    },
    alive: () => state.open,
  };
  return state;
}

/**
 * A run with no notebook: `create` answers the first lab state and `read` the
 * rest. `saved` lists notebooks instead, and `open` answers the first state.
 */
function deps(
  answers: RunQuixLab[],
  clock = { at: 0 },
  saved: Notebook[] = [],
): LaunchDeps & { reads: number; created: number; opened: string[]; readied: string[] } {
  const queue = [...answers];
  const out = {
    reads: 0,
    created: 0,
    opened: [] as string[],
    readied: [] as string[],
    list: () => Promise.resolve(saved),
    create: () => {
      out.created += 1;
      return Promise.resolve(notebook("nb-new", queue.shift()!));
    },
    open: (_runId: string, id: string) => {
      out.opened.push(id);
      return Promise.resolve(notebook(id, queue.shift()!));
    },
    read: () => {
      out.reads += 1;
      return Promise.resolve(queue.shift()!);
    },
    ready: (url: string) => {
      out.readied.push(url);
      return Promise.resolve(true);
    },
    wait: (ms: number) => {
      clock.at += ms;
      return Promise.resolve();
    },
    now: () => clock.at,
  };
  return out;
}

describe("running", () => {
  it("is only the Portal's own word for a service that answers", () => {
    expect(running(lab("Running"))).toBe(true);
    expect(running(lab(" running "))).toBe(true);
    for (const status of ["Building", "Queued", "Starting", "Stopped", ""]) {
      expect(running(lab(status)), status).toBe(false);
    }
  });
});

describe("launchRunQuixLab", () => {
  it("sends the tab straight to a lab that is already running", async () => {
    const tab = fakeTab();
    const d = deps([lab("Running")]);

    await launchRunQuixLab("r1", tab, d);

    expect(tab.went).toEqual(["https://tm-lab-a.dev.quix.io"]);
    expect(d.reads).toBe(0);
    expect(d.created).toBe(1);
    expect(tab.offered).toEqual([]);
  });

  it("waits for the lab to ANSWER before sending the tab, Running or not", async () => {
    // Running is the pod; the server inside listens later, and a tab sent
    // early lands on the ingress's error page.
    const tab = fakeTab();
    const d = deps([lab("Running")]);
    const order: string[] = [];
    const slow = {
      ...d,
      ready: (url: string) => {
        order.push(`ready ${url}`);
        return Promise.resolve(true);
      },
    };
    tab.go = (url: string) => order.push(`go ${url}`);

    await launchRunQuixLab("r1", tab, slow);

    expect(order).toEqual(["ready https://tm-lab-a.dev.quix.io", "go https://tm-lab-a.dev.quix.io"]);
  });

  it("does not send a tab the person closed while the lab was answering", async () => {
    const tab = fakeTab();
    const d = deps([lab("Running")]);
    const closing = {
      ...d,
      ready: () => {
        tab.open = false;
        return Promise.resolve(true);
      },
    };

    await launchRunQuixLab("r1", tab, closing);

    expect(tab.went).toEqual([]);
  });

  it("opens the NEWEST saved notebook rather than making another", async () => {
    const tab = fakeTab();
    const d = deps([lab("Running")], { at: 0 }, [notebook("nb-old"), notebook("nb-new")]);

    await launchRunQuixLab("r1", tab, d);

    expect(d.created).toBe(0);
    expect(d.opened).toEqual(["nb-new"]);
    expect(tab.went).toEqual(["https://tm-lab-a.dev.quix.io"]);
  });

  it("reads the lab when the open answered none, rather than sending the tab nowhere", async () => {
    const tab = fakeTab();
    const d = deps([lab("Running")], { at: 0 }, [notebook("nb-1")]);
    const bare = { ...d, open: (_r: string, id: string) => Promise.resolve(notebook(id, null)) };

    await launchRunQuixLab("r1", tab, bare);

    expect(d.reads).toBe(1);
    expect(tab.went).toEqual(["https://tm-lab-a.dev.quix.io"]);
  });

  it("waits out a build rather than showing a 502, then goes", async () => {
    const tab = fakeTab();
    const d = deps([lab("Building"), lab("Building"), lab("Running")]);

    await launchRunQuixLab("r1", tab, d);

    expect(d.reads).toBe(2);
    expect(tab.went).toEqual(["https://tm-lab-a.dev.quix.io"]);
    expect(tab.said.some((line) => line.includes("Building"))).toBe(true);
  });

  it("stops the moment the person closes the tab", async () => {
    const tab = fakeTab();
    const d = deps([lab("Building"), lab("Building"), lab("Running")]);
    const closeAfterFirst = {
      ...d,
      wait: (ms: number) => {
        tab.open = false;
        return d.wait(ms);
      },
    };

    await launchRunQuixLab("r1", tab, closeAfterFirst);

    expect(tab.went).toEqual([]);
    expect(d.reads).toBe(1);
  });

  it("offers a link instead of redirecting when the build outlasts the wait", async () => {
    const tab = fakeTab();
    const clock = { at: 0 };
    const stuck = {
      ...deps([], clock),
      create: () => Promise.resolve(notebook("nb-new", lab("Building"))),
      read: () => Promise.resolve(lab("Building")),
      wait: (ms: number) => {
        clock.at += ms;
        return Promise.resolve();
      },
      now: () => clock.at,
      reads: 0,
    };

    await launchRunQuixLab("r1", tab, stuck);

    expect(clock.at).toBeGreaterThanOrEqual(GIVE_UP_MS);
    expect(tab.went).toEqual([]);
    expect(tab.offered).toHaveLength(1);
    expect(tab.offered[0]).toContain("https://tm-lab-a.dev.quix.io");
  });

  it("lets a failure to create reach the caller, which closes the tab", async () => {
    const tab = fakeTab();
    const failing = {
      ...deps([]),
      create: () => Promise.reject(new Error("no QuixLab to clone")),
    };

    await expect(launchRunQuixLab("r1", tab, failing)).rejects.toThrow("no QuixLab to clone");
    expect(tab.went).toEqual([]);
  });
});

describe("claimTab", () => {
  it("returns null when the browser blocks the tab, so the caller can say so", async () => {
    const { claimTab } = await import("@/lib/run-quixlab");

    expect(claimTab(vi.fn(() => null) as unknown as Window["open"])).toBeNull();
  });

  it("severs the child's back-reference, since noopener would leave no handle", async () => {
    const { claimTab } = await import("@/lib/run-quixlab");
    const win = {
      opener: {} as unknown,
      closed: false,
      location: { replace: vi.fn() },
      document: { open: vi.fn(), write: vi.fn(), close: vi.fn() },
    };

    const tab = claimTab(vi.fn(() => win) as unknown as Window["open"])!;

    expect(win.opener).toBeNull();
    expect(tab.alive()).toBe(true);
    tab.go("https://lab.example");
    expect(win.location.replace).toHaveBeenCalledWith("https://lab.example");
  });

  it("escapes what it writes into the blank document", async () => {
    const { claimTab } = await import("@/lib/run-quixlab");
    const written: string[] = [];
    const win = {
      opener: null,
      closed: false,
      location: { replace: vi.fn() },
      document: { open: vi.fn(), write: (html: string) => written.push(html), close: vi.fn() },
    };

    claimTab(vi.fn(() => win) as unknown as Window["open"])!.say("<script>alert(1)</script>");

    expect(written[0]).not.toContain("<script>alert(1)</script>");
    expect(written[0]).toContain("&lt;script&gt;");
  });
});

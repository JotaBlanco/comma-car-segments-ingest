/**
 * The Explore page: QuixLab's Explorer mounted on the sessions picked here, re-rooted in
 * place when the pick changes, with a link's run joining the sessions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const nav = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/explore",
  useSearchParams: () => nav.params,
}));
vi.mock("@/lib/hooks", () => ({
  useWorkOrders: () => ({ data: { items: [] }, isPending: false, isError: false }),
  useWorkOrder: () => ({ data: undefined, isPending: false, isError: false }),
  useTestDefinitions: () => ({ data: { items: [] }, isPending: false, isError: false }),
  useRuns: () => ({ data: undefined, isPending: false, isError: false, isSuccess: false }),
  /* The sessions dialog this screen offers reads the lake's own tree. */
  useLakeLevel: () => ({ data: { partitions: [] }, isPending: false, isError: false, error: null }),
  useLakeSessions: () => ({ data: { values: [] }, isPending: false, isError: false, error: null }),
}));
const measure = vi.hoisted(() => ({ loads: [] as unknown[], mounts: 0, renders: 0 }));
vi.mock("@/lib/explore/measure-loader", () => ({
  ensureMeasureLoaded: async () => {
    window.MeasureView = {
      mount: () => {
        measure.mounts += 1;
        return {
          load: (l: unknown) => {
            measure.loads.push(l);
          },
          serialize: () => ({ table: "t" }),
          destroy: () => {},
          setTheme: () => {},
          renderTree: () => {
            measure.renders += 1;
          },
          state: { table: "t" },
        };
      },
    };
    window.MeasureLake = { provider: () => ({}), pick: () => "lake" };
  },
}));

import { ExploreScreen, EXPLORE_SESSIONS_KEY } from "@/components/screens/explore/explore-screen";
import { setLakePartitions } from "@/lib/explore/lake-partitions";

beforeEach(() => {
  /* A small estate: one folder above the session, one level inside it. */
  setLakePartitions("platform,run_id", "signal");
  window.localStorage.clear();
  measure.loads = [];
  measure.mounts = 0;
  measure.renders = 0;
  nav.params = new URLSearchParams();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = {
        combinations: [
          { platform: "sn002", run_id: new URL(url, "http://x").searchParams.get("where")?.match(/"run_id":"([^"]+)"/)?.[1] },
        ],
      };
      return { json: async () => body } as Response;
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("ExploreScreen", () => {
  it("mounts once and roots the tree on the run a link names, which joins the sessions", async () => {
    nav.params = new URLSearchParams("run=r1&t0=1000&t1=2000");
    render(<ExploreScreen />);
    await waitFor(() => expect(measure.loads).toHaveLength(1));
    expect(measure.mounts).toBe(1);
    // The layout never roots the tree: the provider does, so no session row is drawn.
    expect(measure.loads[0]).toMatchObject({ table: expect.any(String), roots: [] });
    expect(JSON.parse(window.localStorage.getItem(EXPLORE_SESSIONS_KEY) ?? "[]")).toEqual(["r1"]);
    expect(screen.getByRole("button", { name: "Sessions" })).toHaveTextContent("r1");
  });

  it("re-roots in place when a session is removed, and offers the sessions dialog", async () => {
    window.localStorage.setItem(EXPLORE_SESSIONS_KEY, JSON.stringify(["r1", "r2"]));
    render(<ExploreScreen />);
    await waitFor(() => expect(measure.loads).toHaveLength(1));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Remove r2" }));
    await waitFor(() => expect(measure.renders).toBe(1));
    expect(measure.loads).toHaveLength(1);
    expect(measure.mounts).toBe(1);
    await user.click(screen.getByRole("button", { name: "Sessions" }));
    await user.click(await screen.findByRole("menuitem", { name: /Choose sessions/ }));
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Sessions" })).toBeInTheDocument();
  });
});

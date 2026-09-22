/**
 * "Open in QuixLab" really opens QuixLab.
 *
 * The control showed a toast and opened nothing until 21 Aug 2026. This file
 * guards the three things the replacement must hold:
 *
 *   1. a click opens the configured site root plus the constant deep link;
 *   2. no opened URL carries a token, a secret or any other credential;
 *   3. no URL, no control, and a stray call still opens nothing.
 *
 * Rule 2 is why the route was rebuilt at all. The old Test Manager put a bearer
 * in the QuixLab query string (`backend/api/routes/integrations.py:311`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  usePathname: () => "/runs",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("@/lib/hooks", () => ({
  useHomeSummary: () => ({ data: undefined }),
  usePlanningSyncStatus: () => ({ data: undefined }),
}));

/* The sidebar asks the Portal for the QuixLab deployment id, because
   `TM_QUIXLAB_URL` carries none. Every case below decides the answer itself. */
const { listQuixLabs, getLakehouseUrl } = vi.hoisted(() => ({
  listQuixLabs: vi.fn(),
  getLakehouseUrl: vi.fn(),
}));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs, getLakehouseUrl }));

import { Sidebar } from "@/components/shell/sidebar";
import { setActivePortalToken } from "@/lib/portal/token-store";
import {
  openQuixLab,
  quixLabConfigured,
  setQuixLabPortalUrl,
  setQuixLabUrl,
  type QuixLabInstance,
} from "@/lib/quixlab";

const BASE = "https://quixlab-abc123.dev.quix.io";
const DEEP_LINK = "?open=analysis&kind=notebook";

/* The one URL the demo must open: the Portal's embedded view of the QuixLab
   DEPLOYMENT, in the workspace. The raw deployment host is not it. */
const WORKSPACE = "quixdev-testmanagerdemo-dev";
const DEPLOYMENT = "cb58542a-e346-4678-a16d-02e89eabc0c4";
const PORTAL_EMBEDDED =
  `https://portal.dev.quix.io/pipeline/deployments/${DEPLOYMENT}/embedded?workspace=${WORKSPACE}`;

function quixLabRow(over: Partial<QuixLabInstance> = {}): QuixLabInstance {
  return {
    id: DEPLOYMENT,
    name: "QuixLab",
    kind: "deployment",
    status: "Running",
    url: BASE,
    embed_url: `${BASE}?isIframe=true`,
    origin: BASE,
    portal_embedded_url: PORTAL_EMBEDDED,
    ...over,
  };
}

let opened: string[];
let open: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  listQuixLabs.mockReset();
  listQuixLabs.mockResolvedValue([]);
  getLakehouseUrl.mockReset();
  getLakehouseUrl.mockResolvedValue("");
  setQuixLabPortalUrl(null);
  opened = [];
  open = vi.spyOn(window, "open").mockImplementation((url) => {
    opened.push(String(url));
    return null;
  });
});

afterEach(() => {
  open.mockRestore();
  setQuixLabUrl(null);
  setQuixLabPortalUrl(null);
});

describe("openQuixLab", () => {
  it("opens the site root plus the one deep link that works", () => {
    setQuixLabUrl(BASE);

    openQuixLab();

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });

  it("opens a new tab that cannot reach back through window.opener", () => {
    setQuixLabUrl(BASE);

    openQuixLab();

    expect(open).toHaveBeenCalledWith(expect.any(String), "_blank", "noopener,noreferrer");
  });

  it("opens nothing at all when no URL reached the module", () => {
    setQuixLabUrl("");

    openQuixLab();

    expect(quixLabConfigured()).toBe(false);
    expect(opened).toEqual([]);
  });

  it("carries the run id, so a tab opens the same run the frame opens", () => {
    setQuixLabUrl(BASE);

    openQuixLab(BASE, "RUN-2026-0042");

    expect(opened).toEqual([`${BASE}${DEEP_LINK}&run=RUN-2026-0042`]);
  });

  it("encodes a run id that carries a query character", () => {
    setQuixLabUrl(BASE);

    openQuixLab(BASE, "RUN &=?#1");

    expect(new URL(opened[0]).searchParams.get("run")).toBe("RUN &=?#1");
  });

  it("leaves the link exactly as it was when no run id reaches it", () => {
    setQuixLabUrl(BASE);

    openQuixLab(BASE, "   ");

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });

  it("puts no credential in the URL it opens", () => {
    setQuixLabUrl(BASE);

    openQuixLab();

    const url = opened[0];
    for (const secret of ["token", "secret", "password", "bearer", "@"]) {
      expect(url.toLowerCase()).not.toContain(secret);
    }
    // The deep link is the whole query. Nothing else may join it.
    expect(new URL(url).search).toBe(DEEP_LINK);
  });
});

describe("the sidebar QuixLab control", () => {
  it("opens QuixLab on a click, and hides itself with no URL", async () => {
    const hidden = render(<Sidebar />);
    expect(hidden.queryByRole("button", { name: /QuixLab/ })).toBeNull();
    hidden.unmount();

    setQuixLabUrl(BASE);
    const shown = render(<Sidebar />);
    await userEvent.setup().click(shown.getByRole("button", { name: /QuixLab/ }));

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });
});

/**
 * The Portal's embedded view is the destination, not the deployment host.
 *
 * These four cases are the whole point of the change. A link that opens
 * `https://quixlab-....deployments-dev.quix.io` leaves the Portal, loses the
 * Portal chrome and shows a bare notebook. The demo needs the Portal page that
 * frames it.
 */
describe("the Portal embedded view", () => {
  it("keeps the workspace query and adds the deep link with an ampersand", () => {
    setQuixLabUrl(BASE);

    openQuixLab(PORTAL_EMBEDDED);

    expect(opened).toEqual([`${PORTAL_EMBEDDED}&open=analysis&kind=notebook`]);
    const query = new URL(opened[0]).searchParams;
    expect(query.get("workspace")).toBe(WORKSPACE);
    expect(query.get("open")).toBe("analysis");
    expect(query.get("kind")).toBe("notebook");
  });

  it("carries the run id, so the framed notebook opens the same run", () => {
    setQuixLabUrl(BASE);

    openQuixLab(PORTAL_EMBEDDED, "RUN-2026-0042");

    expect(new URL(opened[0]).searchParams.get("run")).toBe("RUN-2026-0042");
  });

  it("puts no credential in the Portal URL either", () => {
    setQuixLabUrl(BASE);

    openQuixLab(PORTAL_EMBEDDED, "RUN-2026-0042");

    const url = opened[0].toLowerCase();
    for (const secret of ["token", "secret", "password", "bearer", "@"]) {
      expect(url).not.toContain(secret);
    }
  });

  it("falls back to the QuixLab root when nothing resolved a Portal URL", () => {
    setQuixLabUrl(BASE);

    openQuixLab();

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });
});

describe("the sidebar QuixLab control opens the Portal", () => {
  /* The route reads the viewer's own Portal token, so every case holds one.
     The case below proves what happens while it is still missing. */
  beforeEach(() => setActivePortalToken("viewer-token"));
  afterEach(() => setActivePortalToken(null));

  it("opens the Portal embedded view of the QuixLab deployment", async () => {
    listQuixLabs.mockResolvedValue([quixLabRow()]);
    setQuixLabUrl(BASE);

    const view = render(<Sidebar />);
    const item = await view.findByRole("button", { name: /QuixLab/ });
    await waitFor(() => expect(listQuixLabs).toHaveBeenCalled());
    await userEvent.setup().click(item);

    expect(opened).toEqual([`${PORTAL_EMBEDDED}&open=analysis&kind=notebook`]);
  });

  it("keeps the direct link when the Portal names no deployment", async () => {
    listQuixLabs.mockResolvedValue([quixLabRow({ portal_embedded_url: "" })]);
    setQuixLabUrl(BASE);

    const view = render(<Sidebar />);
    const item = await view.findByRole("button", { name: /QuixLab/ });
    await waitFor(() => expect(listQuixLabs).toHaveBeenCalled());
    await userEvent.setup().click(item);

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });

  it("keeps the direct link when the Portal call fails", async () => {
    listQuixLabs.mockRejectedValue(new Error("the platform did not answer"));
    setQuixLabUrl(BASE);

    const view = render(<Sidebar />);
    const item = await view.findByRole("button", { name: /QuixLab/ });
    await waitFor(() => expect(listQuixLabs).toHaveBeenCalled());
    await userEvent.setup().click(item);

    expect(opened).toEqual([`${BASE}${DEEP_LINK}`]);
  });
});

/**
 * The `/quixlab` page frames the workspace QuixLab.
 *
 * Validates architecture.md "The two pages": `/quixlab` reads
 * `GET /integrations/quixlabs`, resolves `workspaceQuixLab(rows)`, and frames
 * it with `embed_url` / `origin` — never `portal_embedded_url`, which is a
 * TAB-only address that would nest Portal chrome inside the content area and
 * never fire the token handshake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const { listQuixLabs } = vi.hoisted(() => ({ listQuixLabs: vi.fn() }));
vi.mock("@/lib/api/integrations", () => ({ listQuixLabs }));

import { QuixLabScreen } from "@/components/screens/quixlab/quixlab-screen";
import { setActivePortalToken } from "@/lib/portal/token-store";
import type { QuixLabInstance } from "@/lib/quixlab";

const ORIGIN = "https://quixlab-dep1.dev.quix.io";
const PORTAL_EMBEDDED =
  "https://portal.dev.quix.io/pipeline/deployments/dep-1/embedded?workspace=ws-demo";

const lab: QuixLabInstance = {
  id: "dep-1",
  name: "QuixLab shared",
  kind: "deployment",
  status: "Running",
  url: ORIGIN,
  embed_url: `${ORIGIN}?isIframe=true`,
  origin: ORIGIN,
  portal_embedded_url: PORTAL_EMBEDDED,
};

beforeEach(() => {
  listQuixLabs.mockReset();
  setActivePortalToken("token-one");
});

afterEach(() => {
  setActivePortalToken(null);
  vi.restoreAllMocks();
});

describe("QuixLabScreen", () => {
  it("frames the workspace QuixLab with embed_url and origin, never portal_embedded_url", async () => {
    listQuixLabs.mockResolvedValue([lab]);
    const view = render(<QuixLabScreen />);

    const frame = await waitFor(() => {
      const el = view.container.querySelector("iframe");
      if (el === null) throw new Error("the frame did not render");
      return el;
    });
    await waitFor(() => expect(frame.getAttribute("src")).toBe(lab.embed_url));

    expect(frame.getAttribute("src")).not.toBe(PORTAL_EMBEDDED);
    expect(frame.getAttribute("title")).toBe(`QuixLab - ${lab.name}`);
  });

  it("shows an empty state when no QuixLab resolves", async () => {
    listQuixLabs.mockResolvedValue([]);
    const view = render(<QuixLabScreen />);

    await waitFor(() => expect(view.getByText("No QuixLab")).toBeInTheDocument());
    expect(view.container.querySelector("iframe")).toBeNull();
  });
});

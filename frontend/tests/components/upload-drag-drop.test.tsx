/**
 * FR-DM-077 — a person drops a file on the upload control.
 *
 * A drop must reach the same function the file input reaches, so the dropped
 * file fills the name, the result key and the produced-at time exactly as a
 * picked file fills them. The input stays, because a keyboard needs it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { UploadResultDialog } from "@/components/screens/run-detail/upload-result-dialog";
import { setActivePortalToken } from "@/lib/portal/token-store";
import { setPortalApiBase } from "@/lib/portal/client";

const RUN_ID = "TAS-88214";
const PORTAL_API = "https://portal-api.dev.quix.io";
/** 14 Aug 2026, 12:02 UTC. It holds no second, so a minute box returns it whole. */
const STAMP = Date.UTC(2026, 7, 14, 12, 2, 0);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://localhost");
      if (url.pathname === "/profile") {
        return json({
          userId: "u-1",
          email: "e.lindqvist@volvo.com",
          firstName: "Erika",
          lastName: "Lindqvist",
        });
      }
      if (url.pathname === "/organisations/current") return new Response(null, { status: 204 });
      if (url.pathname === `/api/proxy/test-runs/${RUN_ID}/files`) return json({ items: [] });
      throw new TypeError(`no stub for ${input}`);
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** Render the dialog open, and wait for the Portal identity it needs. */
async function renderDialog(): Promise<void> {
  render(<UploadResultDialog runId={RUN_ID} open onOpenChange={() => undefined} />, {
    wrapper: Wrapper,
  });
  await screen.findByText("Erika Lindqvist");
}

function resultFile(filename: string, lastModified = STAMP): File {
  return new File(["result bytes"], filename, {
    type: "application/octet-stream",
    lastModified,
  });
}

/** The value of one text box of the dialog. */
function fieldValue(label: string): string {
  return (screen.getByLabelText(label) as HTMLInputElement).value;
}

function zone(): HTMLElement {
  return screen.getByTestId("file-drop-zone");
}

/**
 * Drop a payload on the zone the way a browser hands one over. It answers
 * false when a handler cancelled the browser's default, exactly as
 * `dispatchEvent` does.
 */
function drop(files: File[], types = ["Files"]): boolean {
  return fireEvent.drop(zone(), { dataTransfer: { files, types } });
}

beforeEach(() => {
  setPortalApiBase(PORTAL_API);
  window.localStorage.setItem("tm.portal.token", "portal-pat");
  setActivePortalToken(null);
  stubFetch();
});

afterEach(() => {
  setPortalApiBase(null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("a dropped file fills the same boxes a picked file fills", () => {
  it("fills the name, the result key and the file's own produced-at time", async () => {
    await renderDialog();

    drop([resultFile("thermal_summary_v1.parquet")]);

    expect(fieldValue("Name")).toBe("thermal_summary_v1.parquet");
    expect(fieldValue("Result key")).toBe("thermal_summary_v1");
    expect(new Date(fieldValue("Produced at")).getTime()).toBe(STAMP);
  });

  it("leaves the tool, the version and the parameters empty, as a pick does", async () => {
    await renderDialog();

    drop([resultFile("brake.csv")]);

    expect(fieldValue("Tool")).toBe("");
    expect(fieldValue("Tool version")).toBe("");
    expect(fieldValue("Parameters")).toBe("");
    expect(fieldValue("Description (optional)")).toBe("");
  });

  it("takes the first file of a drop of many, and ignores the rest", async () => {
    await renderDialog();

    drop([resultFile("first_summary.parquet"), resultFile("second_summary.parquet")]);

    expect(fieldValue("Name")).toBe("first_summary.parquet");
    expect(fieldValue("Result key")).toBe("first_summary");
  });

  it("keeps a typed name, exactly as a second pick keeps it", async () => {
    const user = userEvent.setup();
    await renderDialog();

    drop([resultFile("thermal_summary_v1.parquet")]);
    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Cycle aggregates");
    drop([resultFile("brake_summary_v2.csv")]);

    expect(fieldValue("Name")).toBe("Cycle aggregates");
    expect(fieldValue("Result key")).toBe("brake_summary_v2");
  });
});

describe("a drop that carries no file changes nothing", () => {
  it("ignores text dragged from another page", async () => {
    await renderDialog();
    const before = fieldValue("Produced at");

    expect(() => drop([], ["text/plain"])).not.toThrow();

    expect(fieldValue("Name")).toBe("");
    expect(fieldValue("Result key")).toBe("");
    expect(fieldValue("Produced at")).toBe(before);
  });

  it("ignores a drop that carries no dataTransfer at all", async () => {
    await renderDialog();

    expect(() => fireEvent.drop(zone())).not.toThrow();

    expect(fieldValue("Name")).toBe("");
  });
});

describe("the zone cancels the browser's default, so the tab never navigates", () => {
  it("cancels dragover and drop", async () => {
    await renderDialog();

    // `fireEvent` answers false when a handler called preventDefault.
    expect(fireEvent.dragOver(zone(), { dataTransfer: { files: [], types: ["Files"] } })).toBe(
      false,
    );
    expect(drop([resultFile("brake.csv")])).toBe(false);
  });
});

describe("the hover state appears and clears", () => {
  it("marks the zone while a file hovers, and clears when the pointer leaves", async () => {
    await renderDialog();
    expect(zone()).not.toHaveAttribute("data-over");

    fireEvent.dragOver(zone(), { dataTransfer: { files: [], types: ["Files"] } });
    expect(zone()).toHaveAttribute("data-over");

    // The pointer leaves the window, so the browser names no related target.
    fireEvent.dragLeave(zone());
    expect(zone()).not.toHaveAttribute("data-over");
  });

  it("holds the mark while the pointer crosses on to the input inside", async () => {
    await renderDialog();

    fireEvent.dragOver(zone(), { dataTransfer: { files: [], types: ["Files"] } });
    // jsdom carries no `DragEvent`, so `fireEvent` drops a `relatedTarget` in
    // its init. Define it on the event the way a browser sets it.
    const leave = createEvent.dragLeave(zone());
    Object.defineProperty(leave, "relatedTarget", {
      value: screen.getByLabelText("Result file"),
    });
    fireEvent(zone(), leave);

    expect(zone()).toHaveAttribute("data-over");
  });

  it("clears the mark after a drop", async () => {
    await renderDialog();

    fireEvent.dragOver(zone(), { dataTransfer: { files: [], types: ["Files"] } });
    drop([resultFile("brake.csv")]);

    expect(zone()).not.toHaveAttribute("data-over");
  });
});

describe("the file input still works", () => {
  it("keeps a real file input inside the zone, and a pick still fills the boxes", async () => {
    const user = userEvent.setup();
    await renderDialog();

    const box = screen.getByLabelText("Result file") as HTMLInputElement;
    expect(box.type).toBe("file");
    expect(zone()).toContainElement(box);

    await user.upload(box, resultFile("thermal_summary_v1.parquet"));

    expect(fieldValue("Name")).toBe("thermal_summary_v1.parquet");
    expect(fieldValue("Result key")).toBe("thermal_summary_v1");
    expect(new Date(fieldValue("Produced at")).getTime()).toBe(STAMP);
  });
});

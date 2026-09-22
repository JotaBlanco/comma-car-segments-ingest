/**
 * FR-DM-102 — a permanent link to one file version.
 *
 * Every version is its own file document with its own id, and `/files/{id}`
 * renders that one document. The control must therefore copy the row's own
 * id, never the id of the newest version. The test drives the real path: the
 * panel, the hook, the API client and `fetch`. Only `fetch` and the clipboard
 * are stubs.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
  FileVersionsPanel,
  versionLink,
} from "@/components/screens/files/file-versions-panel";
import type { FileDetail, FileEntity } from "@/types";

const V1_ID = "f-11111111-1111-4111-8111-111111111111";
const V2_ID = "f-22222222-2222-4222-8222-222222222222";
const ORIGIN = "http://localhost:3000";

/** The text the app last wrote to the clipboard. */
let clipboardText: string | null = null;
/** The next clipboard write fails when this is true. */
let clipboardRefuses = false;
/** The toasts the panel fired, newest last. */
const { toasts } = vi.hoisted(() => ({ toasts: [] as string[] }));

vi.mock("sonner", () => {
  const record = (message: unknown): string => {
    toasts.push(String(message));
    return "toast-id";
  };
  const toast = Object.assign(record, {
    success: record,
    error: record,
    info: record,
    warning: record,
    message: record,
    loading: record,
    custom: record,
    dismiss: vi.fn(),
    promise: vi.fn(),
  });
  return { toast, Toaster: () => null };
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fileRow(overrides: Partial<FileEntity> = {}): FileEntity {
  return {
    file_id: V1_ID,
    filename: "bat_cyc_20260814_0941.mf4",
    run_id: "TAS-88214",
    source_system: "TAS",
    format: "MF4",
    size_bytes: 4096,
    checksum_sha256: "a".repeat(64),
    checksum_state: "verified",
    status: "registered",
    quarantine_reason: null,
    lifecycle: "active",
    version: 1,
    sync_status: "success",
    upload_status: "success",
    conversion_status: "success",
    stage_error: null,
    signal_count: 2,
    time_start: "2026-08-14T09:00:00Z",
    time_end: "2026-08-14T11:00:00Z",
    registered_at: "2026-08-14T10:02:00Z",
    ...overrides,
  };
}

/** The chain the route answers with — oldest first, as the API serves it. */
const CHAIN: FileEntity[] = [
  fileRow(),
  fileRow({ file_id: V2_ID, version: 2, checksum_sha256: "b".repeat(64) }),
];

function fileDetail(): FileDetail {
  return {
    ...fileRow(),
    storage_ref: "tas-raw/2026/08/bat_cyc_20260814_0941.mf4",
    ingestion_job_id: "ing-8841",
    field_sources: {},
    ingestion_timeline: [],
    signals: [],
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  clipboardText = null;
  clipboardRefuses = false;
  toasts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, ORIGIN);
      if (url.pathname === `/api/proxy/files/${V1_ID}/versions`) {
        return json({ items: CHAIN, total: CHAIN.length });
      }
      throw new TypeError(`no stub for ${input}`);
    }),
  );
});

/* `userEvent.setup()` installs its own clipboard stub, so this one goes in
   after the user exists, never before. */
function stubClipboard(): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: vi.fn(async (text: string) => {
        if (clipboardRefuses) throw new Error("the browser refused the clipboard");
        clipboardText = text;
      }),
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderPanel(): Promise<void> {
  render(<FileVersionsPanel file={fileDetail()} />, { wrapper: Wrapper });
  await screen.findByRole("button", { name: `Copy link to version 1 of ${fileRow().filename}` });
}

describe("the link a version row copies names that one version", () => {
  it("builds the link from the row id, so a newer version never takes it over", () => {
    expect(versionLink(V1_ID, ORIGIN)).toBe(`${ORIGIN}/files/${V1_ID}`);
    expect(versionLink(V2_ID, ORIGIN)).toBe(`${ORIGIN}/files/${V2_ID}`);
    // The two links differ, so neither resolves to "the newest".
    expect(versionLink(V1_ID, ORIGIN)).not.toBe(versionLink(V2_ID, ORIGIN));
  });

  it("copies the older version's own id, not the newest id", async () => {
    const user = userEvent.setup();
    stubClipboard();
    await renderPanel();

    await user.click(
      screen.getByRole("button", { name: `Copy link to version 1 of ${fileRow().filename}` }),
    );

    await waitFor(() => expect(clipboardText).toBe(`${ORIGIN}/files/${V1_ID}`));
    expect(clipboardText).not.toContain(V2_ID);
    expect(toasts.some((message) => message.includes("version 1"))).toBe(true);
  });

  it("copies the newest version's own id from its own row", async () => {
    const user = userEvent.setup();
    stubClipboard();
    await renderPanel();

    await user.click(
      screen.getByRole("button", { name: `Copy link to version 2 of ${fileRow().filename}` }),
    );

    await waitFor(() => expect(clipboardText).toBe(`${ORIGIN}/files/${V2_ID}`));
  });

  it("hands the link over when the browser refuses the clipboard", async () => {
    clipboardRefuses = true;
    const user = userEvent.setup();
    stubClipboard();
    await renderPanel();

    await user.click(
      screen.getByRole("button", { name: `Copy link to version 1 of ${fileRow().filename}` }),
    );

    await waitFor(() =>
      expect(toasts.some((message) => message.includes("Copy the link by hand"))).toBe(true),
    );
    expect(clipboardText).toBeNull();
  });
});

/**
 * Accepting a draft notebook.
 *
 * A draft notebook's row offers Accept; a plain notebook's does not. The dialog shows
 * the exact module the API would store and accepts it by the digest it showed, so a
 * cell edited in the meantime is refused and read again rather than stored unseen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import userEvent from "@testing-library/user-event";

const { acceptDraft, listNotebooks, previewDraft } = vi.hoisted(() => ({
  acceptDraft: vi.fn(),
  listNotebooks: vi.fn(),
  previewDraft: vi.fn(),
}));
vi.mock("@/lib/api/run-quixlab", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/run-quixlab")>()),
  acceptDraft,
  listNotebooks,
  previewDraft,
}));

import { QuixLabPanel } from "@/components/screens/run-detail/quixlab-panel";
import { ApiError } from "@/lib/api/client";
import type { DraftImplementation, Notebook } from "@/lib/api/run-quixlab";

const RUN_ID = "TAS-1001";
const TD = "BAT-SYS-TC-003";

const plain: Notebook = {
  notebook_id: "nb-1",
  run_id: RUN_ID,
  name: "Notebook 1",
  created_by: "viewer",
  created_at: "2026-09-25T09:00:00Z",
  saved_at: null,
  lab: null,
};
const draftNotebook: Notebook = {
  ...plain,
  notebook_id: "nb-draft",
  name: `Draft ${TD}`,
  definition_id: TD,
};
const draft: DraftImplementation = {
  definition_id: TD,
  filename: `${TD}.py`,
  code: "def evaluate(run_id, table):\n    return {'verdict': 'PASS'}\n",
  sha256: "a".repeat(64),
};

function withClient(node: ReactElement): ReactElement {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

beforeEach(() => {
  listNotebooks.mockReset();
  previewDraft.mockReset();
  acceptDraft.mockReset();
  listNotebooks.mockResolvedValue([plain, draftNotebook]);
  previewDraft.mockResolvedValue(draft);
  acceptDraft.mockResolvedValue({
    filename: `${TD}.py`,
    sha256: draft.sha256,
    size_bytes: draft.code.length,
    entrypoint: "evaluate",
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Accept on a draft notebook", () => {
  it("is offered on a draft notebook only", async () => {
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    expect(await view.findByRole("button", { name: `Accept Draft ${TD}` })).toBeTruthy();
    expect(view.queryByRole("button", { name: "Accept Notebook 1" })).toBeNull();
  });

  it("shows the code and accepts it by the digest it showed", async () => {
    const user = userEvent.setup();
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await user.click(await view.findByRole("button", { name: `Accept Draft ${TD}` }));
    const code = await view.findByLabelText("Code to accept");
    expect(code.textContent).toBe(draft.code);
    expect(previewDraft).toHaveBeenCalledWith(RUN_ID, "nb-draft");

    await user.click(view.getByRole("button", { name: "Accept" }));

    await waitFor(() => expect(acceptDraft).toHaveBeenCalledWith(RUN_ID, "nb-draft", draft.sha256));
    await waitFor(() => expect(view.queryByLabelText("Code to accept")).toBeNull());
  });

  it("reads the code again when it changed since the preview", async () => {
    acceptDraft.mockRejectedValueOnce(
      new ApiError(409, "the draft changed since it was previewed", "draft_changed"),
    );
    const user = userEvent.setup();
    const view = render(withClient(<QuixLabPanel runId={RUN_ID} />));

    await user.click(await view.findByRole("button", { name: `Accept Draft ${TD}` }));
    await view.findByLabelText("Code to accept");
    await user.click(view.getByRole("button", { name: "Accept" }));

    expect((await view.findByRole("alert")).textContent).toContain("changed since you opened");
    await waitFor(() => expect(previewDraft).toHaveBeenCalledTimes(2));
  });
});

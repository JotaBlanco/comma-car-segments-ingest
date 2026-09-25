/**
 * The Requirements panel of the definition detail screen.
 *
 * The panel reads the documents the definition read already carries, and it
 * writes through the real API client and the real hooks. The test stubs
 * `fetch`, so it pins the two wire paths as well as the screen behaviour: a
 * drift on either path is a silent 404 in the app.
 *
 * Config: `vitest.components.config.ts` takes `tests/components/**`.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequirementsPanel } from "@/components/screens/definitions/requirements-panel";
import type { RequirementsFile } from "@/types";

vi.setConfig({ testTimeout: 30_000 });

const TD_ID = "TD-BAT-114";
const COLLECTION = `/api/proxy/test-definitions/${TD_ID}/requirements-files`;

let calls: Array<{ url: string; init: RequestInit }> = [];
/** The next answer the stub gives a write. A test overrides it to refuse. */
let writeAnswer: () => Response = () => new Response(null, { status: 204 });

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string, init: RequestInit = {}) => {
      calls.push({ url: input, init });
      return Promise.resolve(writeAnswer());
    }),
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function planningFile(overrides: Partial<RequirementsFile> = {}): RequirementsFile {
  return {
    name: "acceptance-criteria.md",
    content: "# Acceptance\n\n1. The pack reaches **+40 °C** within 45 min.",
    source: "planning",
    updated_at: "2026-08-13T07:44:00Z",
    updated_by: null,
    ...overrides,
  };
}

function manualFile(overrides: Partial<RequirementsFile> = {}): RequirementsFile {
  return {
    name: "rig-notes.md",
    content: "## Rig notes\n\n- Check the chamber door seal.",
    source: "manual",
    updated_at: "2026-08-14T10:12:00Z",
    updated_by: "a.bergstrom",
    ...overrides,
  };
}

/** One BINARY document. It holds a storage reference and no text. */
function binaryFile(overrides: Partial<RequirementsFile> = {}): RequirementsFile {
  return {
    name: "requirements.pdf",
    content: "",
    source: "manual",
    updated_at: "2026-08-25T09:00:00Z",
    updated_by: "a.bergstrom",
    render_markdown: null,
    storage_ref: "blob://test-manager/requirements/TD-BAT-114/abc-requirements.pdf",
    content_type: "application/pdf",
    size_bytes: 4096,
    ...overrides,
  };
}

function renderPanel(files: RequirementsFile[]) {
  return render(<RequirementsPanel tdId={TD_ID} files={files} />, { wrapper: Wrapper });
}

/** jsdom implements no object URL. The binary body needs one for the preview. */
const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  calls = [];
  writeAnswer = () => new Response(null, { status: 204 });
  stubFetch();
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
});

describe("the Requirements panel", () => {
  it("renders the selected document as markdown, not as marker characters", () => {
    renderPanel([planningFile()]);

    expect(screen.getByRole("heading", { name: "Requirements" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Acceptance", level: 3 })).toBeInTheDocument();
    expect(screen.getByText("+40 °C").tagName).toBe("B");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("states that no document exists yet when the definition carries none", () => {
    renderPanel([]);

    expect(
      screen.getByText("No requirements document sits on this definition yet."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Remove/ })).toBeNull();
  });

  it("names who added a manual document and when", () => {
    renderPanel([manualFile()]);

    expect(screen.getByText("a.bergstrom")).toBeInTheDocument();
  });

  it("shows no remove control on a planning document", () => {
    renderPanel([planningFile()]);

    expect(screen.queryByRole("button", { name: "Remove acceptance-criteria.md" })).toBeNull();
    expect(screen.getByText(/From the catalogue/)).toBeInTheDocument();
  });

  it("shows a remove control on a manual document, and deletes by name", async () => {
    const user = userEvent.setup();
    renderPanel([manualFile()]);

    await user.click(screen.getByRole("button", { name: "Remove rig-notes.md" }));

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "DELETE");
      expect(call?.url).toBe(`${COLLECTION}/rig-notes.md`);
    });
  });

  it("shows the API sentence when the registry refuses a removal", async () => {
    const user = userEvent.setup();
    writeAnswer = () =>
      json(
        {
          detail: "The planning system owns rig-notes.md.",
          code: "requirements_file_not_manual",
          errors: [],
        },
        409,
      );
    renderPanel([manualFile()]);

    await user.click(screen.getByRole("button", { name: "Remove rig-notes.md" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The planning system owns rig-notes.md.",
    );
  });

  it("switches the rendered document when a person picks another name", async () => {
    const user = userEvent.setup();
    renderPanel([manualFile(), planningFile()]);

    // The API sorts manual first, so the manual document opens first.
    expect(screen.getByRole("heading", { name: "Rig notes", level: 4 })).toBeInTheDocument();

    const list = screen.getByRole("list", { name: "Requirements documents" });
    await user.click(within(list).getByText("acceptance-criteria.md"));

    expect(screen.getByRole("heading", { name: "Acceptance", level: 3 })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Rig notes" })).toBeNull();
  });
});

describe("the Add-document control", () => {
  it("posts the name and the text to the requirements-files route", async () => {
    const user = userEvent.setup();
    writeAnswer = () =>
      json(
        {
          name: "scope.md",
          content: "# Scope",
          source: "manual",
          updated_at: "2026-08-24T10:00:00Z",
          updated_by: "a.bergstrom",
        },
        201,
      );
    renderPanel([planningFile()]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.type(screen.getByLabelText("Document name"), "scope.md");
    await user.type(screen.getByLabelText("Document text"), "# Scope");
    await user.click(screen.getAllByRole("button", { name: "Add document" }).at(-1) as HTMLElement);

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "POST");
      expect(call?.url).toBe(COLLECTION);
      expect(JSON.parse(call?.init.body as string)).toEqual({
        name: "scope.md",
        content: "# Scope",
        // The `.md` name turns the switch on by itself.
        render_markdown: true,
      });
    });
  });

  it("shows the API sentence when the registry refuses the document", async () => {
    const user = userEvent.setup();
    writeAnswer = () =>
      json(
        {
          detail: "Test definition TD-BAT-114 already carries a document named scope.md",
          code: "requirements_file_exists",
          errors: [],
        },
        409,
      );
    renderPanel([planningFile()]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.type(screen.getByLabelText("Document name"), "scope.md");
    await user.type(screen.getByLabelText("Document text"), "# Scope");
    await user.click(screen.getAllByRole("button", { name: "Add document" }).at(-1) as HTMLElement);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already carries a document named scope.md",
    );
  });

  it("refuses an empty name before it calls the registry", async () => {
    const user = userEvent.setup();
    renderPanel([]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.type(screen.getByLabelText("Document text"), "# Scope");
    await user.click(screen.getAllByRole("button", { name: "Add document" }).at(-1) as HTMLElement);

    expect(await screen.findByRole("alert")).toHaveTextContent("A document needs a name.");
    expect(calls).toHaveLength(0);
  });
});

describe("the markdown switch", () => {
  it("renders a `.md` document as markdown by default", () => {
    renderPanel([manualFile()]);

    expect(screen.getByRole("switch", { name: "Render as markdown" })).toBeChecked();
    expect(screen.getByRole("heading", { name: "Rig notes", level: 4 })).toBeInTheDocument();
  });

  it("renders another name as plain text by default", () => {
    renderPanel([manualFile({ name: "rig-notes.txt" })]);

    expect(screen.getByRole("switch", { name: "Render as markdown" })).not.toBeChecked();
    expect(screen.queryByRole("heading", { name: "Rig notes" })).toBeNull();
    // The marker characters stay visible, because nothing rendered them.
    expect(screen.getByText(/## Rig notes/)).toBeInTheDocument();
  });

  it("obeys the flag the API states, whatever the name says", () => {
    renderPanel([manualFile({ render_markdown: false })]);

    expect(screen.getByRole("switch", { name: "Render as markdown" })).not.toBeChecked();
    expect(screen.getByText(/## Rig notes/)).toBeInTheDocument();
  });

  it("lets the reader flip it while reading", async () => {
    const user = userEvent.setup();
    renderPanel([manualFile({ name: "rig-notes.txt" })]);

    await user.click(screen.getByRole("switch", { name: "Render as markdown" }));

    expect(screen.getByRole("heading", { name: "Rig notes", level: 4 })).toBeInTheDocument();
  });

  it("renders plain text with its whitespace, and never as markup", () => {
    const { container } = renderPanel([
      manualFile({
        name: "notes.txt",
        content: "  step one\n  <img src=x onerror=alert(1)>",
      }),
    ]);

    expect(container.querySelector("img")).toBeNull();
    const block = container.querySelector("pre");
    expect(block?.textContent).toBe("  step one\n  <img src=x onerror=alert(1)>");
  });

  it("shows no switch on a binary document", () => {
    renderPanel([binaryFile()]);

    expect(screen.queryByRole("switch", { name: "Render as markdown" })).toBeNull();
  });
});

describe("a binary document", () => {
  it("names the type and the size, and offers a download", () => {
    renderPanel([binaryFile({ content_type: "application/vnd.ms-excel" })]);

    expect(screen.getByText("application/vnd.ms-excel")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Download/ })).toBeInTheDocument();
    expect(
      screen.getByText(/The browser shows no preview for this type/),
    ).toBeInTheDocument();
  });

  it("fetches the bytes from the download route when it shows a PDF inline", async () => {
    writeAnswer = () =>
      new Response("%PDF-1.4", {
        status: 200,
        headers: { "content-type": "application/pdf" },
      });
    renderPanel([binaryFile()]);

    await waitFor(() => {
      expect(calls[0]?.url).toBe(`${COLLECTION}/requirements.pdf/download`);
    });
  });

  it("shows an image inline once the bytes arrive", async () => {
    writeAnswer = () =>
      new Response("binary", { status: 200, headers: { "content-type": "image/png" } });
    renderPanel([binaryFile({ name: "rig.png", content_type: "image/png" })]);

    expect(
      await screen.findByRole("img", { name: "rig.png" }, { timeout: 5000 }),
    ).toBeInTheDocument();
  });

  it("never previews a type the browser does not render natively", () => {
    renderPanel([binaryFile({ name: "trap.svg", content_type: "image/svg+xml" })]);

    expect(screen.queryByRole("img")).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe("the Add-document control with a file", () => {
  it("posts the bytes to the multipart upload route", async () => {
    const user = userEvent.setup();
    writeAnswer = () => json(binaryFile(), 201);
    renderPanel([]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.upload(
      screen.getByLabelText("File (optional)"),
      new File(["%PDF-1.4"], "requirements.pdf", { type: "application/pdf" }),
    );
    await user.click(screen.getAllByRole("button", { name: "Add document" }).at(-1) as HTMLElement);

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "POST");
      expect(call?.url).toBe(`${COLLECTION}/upload`);
      const form = call?.init.body as FormData;
      expect(form).toBeInstanceOf(FormData);
      expect((form.get("file") as File).name).toBe("requirements.pdf");
      expect(form.get("name")).toBe("requirements.pdf");
    });
  });

  it("hides the text box and the markdown control once a file is picked", async () => {
    const user = userEvent.setup();
    renderPanel([]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    expect(screen.getByLabelText("Document text")).toBeInTheDocument();

    await user.upload(
      screen.getByLabelText("File (optional)"),
      new File(["%PDF-1.4"], "requirements.pdf", { type: "application/pdf" }),
    );

    expect(screen.queryByLabelText("Document text")).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Render as markdown/ })).toBeNull();
  });

  it("states the markdown flag a person unticks", async () => {
    const user = userEvent.setup();
    writeAnswer = () => json(manualFile(), 201);
    renderPanel([]);

    await user.click(screen.getByRole("button", { name: "Add document" }));
    await user.type(screen.getByLabelText("Document name"), "scope.md");
    await user.type(screen.getByLabelText("Document text"), "# Scope");
    await user.click(screen.getByRole("checkbox", { name: /Render as markdown/ }));
    await user.click(screen.getAllByRole("button", { name: "Add document" }).at(-1) as HTMLElement);

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "POST");
      expect(JSON.parse(call?.init.body as string).render_markdown).toBe(false);
    });
  });
});


describe("the Edit control", () => {
  /** Open the edit dialog on the document the panel shows. */
  async function openEditor(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole("button", { name: `Edit ${name}` }));
    return screen.getByLabelText("Document text");
  }

  it("shows no Edit control on a planning document", () => {
    renderPanel([planningFile()]);

    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });

  it("shows no Edit control on a binary document", () => {
    renderPanel([binaryFile()]);

    expect(screen.queryByRole("button", { name: /^Edit / })).toBeNull();
  });

  it("opens with the stored text and the stored markdown flag", async () => {
    const user = userEvent.setup();
    renderPanel([manualFile({ render_markdown: false })]);

    const box = await openEditor(user, "rig-notes.md");

    expect(box).toHaveValue("## Rig notes\n\n- Check the chamber door seal.");
    expect(screen.getByRole("checkbox", { name: /Render as markdown/ })).not.toBeChecked();
    // The name is the identity of the document, so the dialog never offers it.
    expect(screen.queryByLabelText("Document name")).toBeNull();
  });

  it("patches the content to the document route, and states no name", async () => {
    const user = userEvent.setup();
    writeAnswer = () => json(manualFile({ content: "## Rewritten" }));
    renderPanel([manualFile()]);

    const box = await openEditor(user, "rig-notes.md");
    await user.clear(box);
    await user.type(box, "## Rewritten");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH");
      expect(call?.url).toBe(`${COLLECTION}/rig-notes.md`);
      expect(JSON.parse(call?.init.body as string)).toEqual({
        content: "## Rewritten",
        render_markdown: true,
      });
    });
  });

  it("states the markdown flag a person unticks", async () => {
    const user = userEvent.setup();
    writeAnswer = () => json(manualFile({ render_markdown: false }));
    renderPanel([manualFile()]);

    await openEditor(user, "rig-notes.md");
    await user.click(screen.getByRole("checkbox", { name: /Render as markdown/ }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const call = calls.find((entry) => (entry.init.method ?? "GET").toUpperCase() === "PATCH");
      expect(JSON.parse(call?.init.body as string).render_markdown).toBe(false);
    });
  });

  it("shows the API sentence when the registry refuses the edit", async () => {
    const user = userEvent.setup();
    writeAnswer = () =>
      json(
        {
          detail: "planning owns the requirements file rig-notes.md",
          code: "planning_owned_file",
          errors: [],
        },
        409,
      );
    renderPanel([manualFile()]);

    const box = await openEditor(user, "rig-notes.md");
    await user.clear(box);
    await user.type(box, "## Rewritten");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "planning owns the requirements file rig-notes.md",
    );
  });

  it("refuses an empty document before it calls the registry", async () => {
    const user = userEvent.setup();
    renderPanel([manualFile()]);

    const box = await openEditor(user, "rig-notes.md");
    await user.clear(box);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A document needs some text.");
    expect(calls).toHaveLength(0);
  });
});

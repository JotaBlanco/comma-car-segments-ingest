import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { sourceMeaning, type SignalFacets } from "@/types";

/* FR-DM-111, fourth clause: the API, the CLI and the UI query the same way.
   `GET /signals` takes `source` beside `source_system`, and `tm signals` names
   both. The screen mounted only `source_system`, so the provenance tag was the
   one filter a person could reach from two interfaces and not from the third.

   The control copies the runs screen and the files screen: one
   `MultiSelectFilter`, the `source` URL key, one pill per applied value that
   clears through `toggleFilterValue`. */

const { rows, push, search } = vi.hoisted(() => ({
  rows: { facets: { units: [], rates: [], rigs: [] } as SignalFacets },
  push: vi.fn(),
  search: { value: "" },
}));

vi.mock("@/lib/hooks", () => ({
  usePageTitle: () => undefined,
  useActor: () => "Test Engineer",
  usePatchSignal: () => ({ mutate: vi.fn(), isPending: false }),
  useSignals: () => ({
    data: {
      items: [],
      total: 0,
      page: 1,
      page_size: 20,
      total_pages: 1,
      view_counts: { all: 0, missing_unit: 0 },
    },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
  useSignalFacets: () => ({
    data: rows.facets,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(search.value),
}));

import { SignalsScreen } from "@/components/screens/signals/signals-screen";

/* The saved-search control reads the signed-in Portal identity through a hook
   below the mocked `@/lib/hooks` barrel, so it needs a query client. No token
   reaches this test, so the control sends no request. */
function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/* Every value of the `Source` enum (api/api/models/common.py), in enum order. */
const ENUM_VALUES = [
  "embedded",
  "manual",
  "api:planning",
  "api:config",
  "api:catalogue",
  "api:post-processing",
];

/** What the checkbox is named: the wire value, then the plain-words meaning. */
function accessibleName(value: string): string {
  return `${value}. ${sourceMeaning(value)}`;
}

function setUp(query = ""): void {
  search.value = query;
  push.mockClear();
}

/* The badge is a node, not a string, so the checkbox carries the raw value on
   `aria-label`. `signals-dtype-filter.test.tsx` reads the same attribute. The
   name also states the tag in plain words, so the label starts with the value
   and continues into the meaning. */
function boxFor(scope: ReturnType<typeof within>, value: string): HTMLElement {
  const box = scope
    .getAllByRole("checkbox")
    .find(
      (candidate: HTMLElement) =>
        candidate.getAttribute("aria-label") === accessibleName(value)
    );
  if (box === undefined) throw new Error(`no checkbox for ${value}`);
  return box;
}

/* `^Source$` on purpose. A `^Source` match would also take the "Source system"
   trigger, and the query would fail on two elements. */
/* Every signals filter sits in the Filters panel, which starts shut when the
   URL carries none. A person opens the panel before narrowing, so the helper
   does too. It is idempotent: the button toggles, so a second call on an open
   panel would shut it. */
async function openFiltersPanel(user: UserEvent): Promise<void> {
  const toggle = screen.getByRole("button", { name: /^Filters/ });
  if (toggle.getAttribute("aria-expanded") === "true") return;
  await user.click(toggle);
}

async function openSourceFilter(user: UserEvent) {
  await openFiltersPanel(user);
  await user.click(screen.getByRole("button", { name: /^Source$/, expanded: false }));
  return within(await screen.findByRole("dialog", { name: "Source filter" }));
}

describe("the signals source filter", () => {
  it("offers every value of the Source enum", async () => {
    const user = userEvent.setup();
    setUp();
    render(<SignalsScreen />, { wrapper: Wrapper });

    const source = await openSourceFilter(user);
    const offered = source
      .getAllByRole("checkbox")
      .map((box: HTMLElement) => box.getAttribute("aria-label"));
    expect(offered).toEqual(ENUM_VALUES.map(accessibleName));
  });

  it("writes the selected tag to the URL as a `source` param", async () => {
    const user = userEvent.setup();
    setUp();
    render(<SignalsScreen />, { wrapper: Wrapper });

    const source = await openSourceFilter(user);
    await user.click(boxFor(source, "api:planning"));

    expect(push).toHaveBeenCalledWith("/signals?source=api%3Aplanning", { scroll: false });
  });

  it("removes the param when the pill clears", async () => {
    const user = userEvent.setup();
    setUp("source=manual");
    render(<SignalsScreen />, { wrapper: Wrapper });

    await user.click(screen.getByRole("button", { name: "Remove filter: Source manual" }));

    expect(push).toHaveBeenCalledWith("/signals", { scroll: false });
  });
});

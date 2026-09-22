import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { FileEntity } from "@/types";

const { rows } = vi.hoisted(() => ({ rows: { items: [] as FileEntity[] } }));

// The tab reads the run files through react-query. Stub the hook so each test
// states its own rows and needs no provider.
vi.mock("@/lib/hooks", () => ({
  // The detail screens set the window title through this hook.
  usePageTitle: () => undefined,
  useRunFiles: () => ({
    data: { items: rows.items, total: rows.items.length, page: 1, page_size: 100, total_pages: 1 },
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: vi.fn(),
  }),
}));

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

import { FilesTab } from "@/components/screens/run-detail/files-tab";

const makeFile = (over: Partial<FileEntity> = {}): FileEntity => ({
  file_id: "f-1",
  filename: "bat_cyc.mf4",
  run_id: "TAS-88214",
  source_system: "TAS",
  format: "MDF4",
  size_bytes: 1024,
  checksum_sha256: "a".repeat(64),
  checksum_state: "verified",
  status: "registered",
  quarantine_reason: null,
  signal_count: 12,
  time_start: null,
  time_end: null,
  registered_at: "2026-08-19T00:00:00Z",
  ...over,
});

describe("the run files tab download action", () => {
  it("renders a download button per row, labeled by filename", () => {
    rows.items = [makeFile()];
    render(<FilesTab runId="TAS-88214" />);

    expect(
      screen.getByRole("button", { name: "Download bat_cyc.mf4" }),
    ).not.toBeDisabled();
  });

  it("disables the button for a quarantined file", () => {
    rows.items = [makeFile({ file_id: "f-2", filename: "bad.mf4", status: "quarantined" })];
    render(<FilesTab runId="TAS-88214" />);

    expect(
      screen.getByRole("button", { name: "Download disabled: bad.mf4 is quarantined" }),
    ).toBeDisabled();
  });
});

/**
 * DownloadButton — state machine and quarantine guard
 * (contract v1.1 §D — file download).
 *
 * Covers:
 *  - idle: labeled variant shows "Download · <size>"; row variant shows
 *    the download icon and an aria-label naming the file.
 *  - fetching: aria-busy=true, spinner replaces the icon, disabled.
 *  - done: sonner toast fires ("Downloaded · checksum verified" when the
 *    X-Checksum-State header reads "verified"; plain "Downloaded" otherwise.
 *    The digest header is NOT the claim: every file carries one, and the
 *    pipeline registers real unverified files.)
 *  - error: 503 renders the friendly storage-unreachable message; other
 *    ApiErrors surface the raw `detail`.
 *  - quarantined: button disabled, tooltip explains, click is a no-op.
 *  - stopPropagation: the row variant swallows click and Enter so the
 *    parent <tr> click handler cannot navigate.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { DownloadButton } from "@/components/screens/files/download-button";
import { filesApi, type FileDownload } from "@/lib/api/files";
import { ApiError } from "@/lib/api/client";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.error).mockClear();
});

afterEach(() => {
  URL.createObjectURL = originalCreateObjectURL;
  URL.revokeObjectURL = originalRevokeObjectURL;
  vi.restoreAllMocks();
});

function successfulDownload(overrides: Partial<FileDownload> = {}): FileDownload {
  return {
    blob: new Blob(["mock bytes"], { type: "application/octet-stream" }),
    filename: "bat_cyc_20260814_0941.mf4",
    checksum: "abc123",
    checksumState: "verified",
    journalId: "j-1",
    sizeBytes: 10,
    ...overrides,
  };
}

describe("DownloadButton — header variant (idle state)", () => {
  it("shows the size in the label so the user sees the download weight up front", () => {
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1_240_000_000}
        quarantined={false}
        variant="header"
      />,
    );
    // formatBytes renders 1.24 GB (or similar); assert the label contains
    // "Download · " and a "GB" unit so the intent surfaces on stage.
    const button = screen.getByRole("button", { name: /Download · .* GB/ });
    expect(button).not.toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "false");
  });
});

describe("DownloadButton — row variant (idle state)", () => {
  it("uses an aria-label that names the file so screen readers distinguish rows", () => {
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="row"
      />,
    );
    const button = screen.getByRole("button", { name: "Download bat_cyc.mf4" });
    expect(button).not.toBeDisabled();
  });

  it("stops click propagation so the parent row does not navigate", async () => {
    vi.spyOn(filesApi, "download").mockResolvedValue(successfulDownload());
    const rowClick = vi.fn();
    const user = userEvent.setup();
    render(
      <table>
        <tbody>
          <tr onClick={rowClick}>
            <td>
              <DownloadButton
                fileId="f-1"
                filename="bat_cyc.mf4"
                sizeBytes={1024}
                quarantined={false}
                variant="row"
              />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    await user.click(screen.getByRole("button", { name: "Download bat_cyc.mf4" }));
    expect(rowClick).not.toHaveBeenCalled();
    await waitFor(() => expect(filesApi.download).toHaveBeenCalledWith("f-1", "bat_cyc.mf4"));
  });
});

describe("DownloadButton — fetching state", () => {
  it("disables the button, sets aria-busy and toggles data-download-state=fetching", async () => {
    let resolveDownload: (value: FileDownload) => void = () => undefined;
    const pending = new Promise<FileDownload>((resolve) => {
      resolveDownload = resolve;
    });
    vi.spyOn(filesApi, "download").mockReturnValue(pending);
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    const button = screen.getByRole("button");
    await user.click(button);

    await waitFor(() => expect(button).toHaveAttribute("aria-busy", "true"));
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("data-download-state", "fetching");

    // Clean up the pending promise so the test doesn't leak an unresolved thenable.
    resolveDownload(successfulDownload());
    await waitFor(() => expect(button).toHaveAttribute("data-download-state", "done"));
  });
});

describe("DownloadButton — done state and toasts", () => {
  it("fires the checksum-verified toast when the registry verified the bytes", async () => {
    vi.spyOn(filesApi, "download").mockResolvedValue(
      successfulDownload({ checksum: "abc123", checksumState: "verified" }),
    );
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        "Downloaded · checksum verified",
        expect.any(Object),
      ),
    );
  });

  it("fires a plain Downloaded toast when the response omits a checksum", async () => {
    vi.spyOn(filesApi, "download").mockResolvedValue(
      successfulDownload({ checksum: null, checksumState: null }),
    );
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Downloaded", expect.any(Object)),
    );
  });
});

describe("DownloadButton — error state", () => {
  it("renders the friendly storage-unreachable message on a 503", async () => {
    vi.spyOn(filesApi, "download").mockRejectedValue(
      new ApiError(503, "Storage unreachable — SAG not bound", "storage_unreachable"),
    );
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Download failed",
        expect.objectContaining({
          description: expect.stringContaining("Storage unreachable"),
        }),
      ),
    );
    // The button returns to idle so the user can retry.
    expect(screen.getByRole("button")).not.toBeDisabled();
  });

  it("surfaces the raw detail for a non-503 ApiError", async () => {
    vi.spyOn(filesApi, "download").mockRejectedValue(
      new ApiError(404, "File f-1 not found", "file_not_found"),
    );
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Download failed",
        expect.objectContaining({ description: "File f-1 not found" }),
      ),
    );
  });
});

describe("DownloadButton — quarantined guard", () => {
  it("disables the button and never calls the API on click", async () => {
    const downloadSpy = vi.spyOn(filesApi, "download");
    render(
      <DownloadButton
        fileId="f-1"
        filename="em_eff.mf4"
        sizeBytes={1024}
        quarantined={true}
        variant="row"
      />,
    );
    const button = screen.getByRole("button", {
      name: "Download disabled: em_eff.mf4 is quarantined",
    });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Quarantined files cannot be downloaded");
    // A click on a disabled button is a no-op in JSDOM; assert the API is
    // never called even via fireEvent (which bypasses the disabled state).
    fireEvent.click(button);
    expect(downloadSpy).not.toHaveBeenCalled();
  });
});

describe("DownloadButton — the checksum claim", () => {
  it("never says verified for a file the registry did not verify", async () => {
    // The pipeline registers real `unverified` files, and each one carries a
    // digest. The digest is the producer's word, so the toast must not read it
    // as proof (finding 12, 21 Aug 2026).
    vi.spyOn(filesApi, "download").mockResolvedValue(
      successfulDownload({ checksum: "abc123", checksumState: "unverified" }),
    );
    const user = userEvent.setup();
    render(
      <DownloadButton
        fileId="f-1"
        filename="bat_cyc.mf4"
        sizeBytes={1024}
        quarantined={false}
        variant="header"
      />,
    );
    await user.click(screen.getByRole("button"));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Downloaded", expect.any(Object)),
    );
  });
});

/**
 * HitCard — server-hydrated entity cards (AS-5).
 *
 * A complete run must read "Linked" (the 19 Aug status rename — the assistant
 * never says "Complete" for a planning-linked run); an invalid run keeps its
 * badge and quotes its journal reason with the actor.
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { HitCard } from "@/components/assistant/hit-card";
import { SENSOR_FRAMES } from "@/lib/mock/assistant-script";
import type { AssistantHit } from "@/types";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

const hitsFrame = SENSOR_FRAMES.find(
  (frame): frame is Extract<(typeof SENSOR_FRAMES)[number], { type: "hits" }> =>
    frame.type === "hits",
);
if (hitsFrame === undefined) throw new Error("sensor script has no hits frame");
const invalidHit = hitsFrame.hits[0];

const linkedHit: AssistantHit = {
  entity: "run",
  run_id: "TAS-88209",
  status: "complete",
  rig_id: "rig-04",
  project: "EX90",
  first_data_at: "2026-08-19T08:12:00Z",
  url: "/runs/TAS-88209",
  reason: null,
};

describe("HitCard", () => {
  it("shows the mono run id linking to the run screen", () => {
    render(<HitCard hit={invalidHit} />);
    const link = screen.getByRole("link", { name: "TAS-88012" });
    expect(link).toHaveAttribute("href", "/runs/TAS-88012");
  });

  it("displays 'Linked' — never 'Complete' — for a complete run", () => {
    render(<HitCard hit={linkedHit} />);
    expect(screen.getByText("Linked")).toBeInTheDocument();
    expect(screen.queryByText("Complete")).not.toBeInTheDocument();
  });

  it("keeps the Invalid badge and quotes the journal reason with its actor", () => {
    render(<HitCard hit={invalidHit} />);
    expect(screen.getByText("Invalid")).toBeInTheDocument();
    expect(
      screen.getByText(/Thermocouple drift on TC-4 during thermal soak/),
    ).toBeInTheDocument();
    expect(screen.getByText(/e\.lindqvist/)).toBeInTheDocument();
  });

  it("omits the reason row when the hit carries none", () => {
    render(<HitCard hit={linkedHit} />);
    expect(screen.queryByText(/“/)).not.toBeInTheDocument();
  });
});

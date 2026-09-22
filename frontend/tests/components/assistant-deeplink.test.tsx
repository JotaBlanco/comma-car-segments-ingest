/**
 * DeeplinkButton — the validated deep link (AS-5).
 *
 * It renders the label and the mono URL for an app-relative link, and refuses
 * to render anything for a URL that does not start with "/" — the journal
 * corpus is attacker-writable, so only validated app-relative links are ever
 * clickable (AI-SIDEBAR.md §5.3).
 */

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { DeeplinkButton } from "@/components/assistant/deeplink-button";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

describe("DeeplinkButton", () => {
  it("renders the label and the mono URL, linking to the app screen", () => {
    render(
      <DeeplinkButton
        deeplink={{ label: "Open filtered view", url: "/runs?status=invalid&project=EX90&q=sensor" }}
      />,
    );
    const link = screen.getByRole("link", { name: /Open filtered view/ });
    expect(link).toHaveAttribute("href", "/runs?status=invalid&project=EX90&q=sensor");
    expect(screen.getByText("/runs?status=invalid&project=EX90&q=sensor")).toBeInTheDocument();
  });

  it("refuses an absolute URL — renders nothing", () => {
    const { container } = render(
      <DeeplinkButton deeplink={{ label: "Evil", url: "https://evil.example/phish" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("refuses a scheme-relative URL — renders nothing", () => {
    // "//evil.example" starts with "/" only at first glance; the browser would
    // treat it as protocol-relative and leave the app. Prove it is refused.
    const { container } = render(
      <DeeplinkButton deeplink={{ label: "Evil", url: "//evil.example" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

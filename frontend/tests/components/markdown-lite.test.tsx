import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MarkdownLite } from "@/components/shared/markdown-lite";

describe("MarkdownLite", () => {
  it("renders bold and inline code without the marker characters", () => {
    render(<MarkdownLite text={"run **TAS-88214** logs to `test_signal_samples`"} />);
    expect(screen.getByText("TAS-88214").tagName).toBe("B");
    expect(screen.getByText("test_signal_samples").tagName).toBe("CODE");
    expect(screen.queryByText(/\*\*/)).toBeNull();
  });

  it("renders a pipe table as a real table, dropping the separator row", () => {
    const text = "| Signal | Unit |\n|---|---|\n| Coolant_Flow_Rate | l/min |";
    render(<MarkdownLite text={text} />);
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Signal" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "l/min" })).toBeInTheDocument();
    expect(screen.queryByText("---")).toBeNull();
  });

  it("never renders markdown links as anchors", () => {
    render(<MarkdownLite text={"see [evil](https://evil.example) now"} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/evil/)).toBeInTheDocument();
  });

  it("renders # to ### as headings, one level under the panel head", () => {
    render(<MarkdownLite text={"# Scope\n\n## Acceptance\n\n### Notes"} />);
    expect(screen.getByRole("heading", { name: "Scope", level: 3 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Acceptance", level: 4 })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Notes", level: 5 })).toBeInTheDocument();
    expect(screen.queryByText(/#/)).toBeNull();
  });

  it("renders a dash run as a bullet list", () => {
    render(<MarkdownLite text={"Signals:\n\n- Coolant_Flow_Rate\n- Chamber_Ambient_Temp"} />);
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("UL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Coolant_Flow_Rate")).toBeInTheDocument();
  });

  it("renders a numbered run as an ordered list, and keeps bold inside an item", () => {
    render(<MarkdownLite text={"1. The pack reaches **+40 °C**.\n2. No cell passes 47 °C."} />);
    const list = screen.getByRole("list");
    expect(list.tagName).toBe("OL");
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("+40 °C").tagName).toBe("B");
    expect(screen.queryByText(/^1\./)).toBeNull();
  });

  it("keeps a bold run that opens a line out of the bullet list", () => {
    render(<MarkdownLite text={"**Note** the seal check."} />);
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.getByText("Note").tagName).toBe("B");
  });

  it("renders raw HTML in the text as characters, never as markup", () => {
    render(<MarkdownLite text={"- <img src=x onerror=alert(1)>"} />);
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeInTheDocument();
  });

  it("renders a run of three or more dashes as a horizontal rule", () => {
    const { container } = render(<MarkdownLite text={"Scope\n\n---\n\nLimits"} />);
    expect(container.querySelector("hr")).not.toBeNull();
    expect(screen.queryByText("---")).toBeNull();
    expect(screen.getByText("Scope")).toBeInTheDocument();
    expect(screen.getByText("Limits")).toBeInTheDocument();
  });

  it("renders a fenced block as preformatted text, keeping the whitespace", () => {
    const text = "Run it:\n\n```bash\n  cd api\n  pytest -n 4\n```\n";
    const { container } = render(<MarkdownLite text={text} />);
    const block = container.querySelector("pre");
    expect(block).not.toBeNull();
    // The two indented lines keep their leading spaces and their newline.
    expect(block?.textContent).toBe("  cd api\n  pytest -n 4");
    // The fence characters and the language word never reach the screen.
    expect(screen.queryByText(/```/)).toBeNull();
    expect(screen.queryByText("bash")).toBeNull();
  });

  it("escapes HTML inside a fenced block, so code can never become markup", () => {
    const text = "```\n<script>alert(1)</script>\n```";
    const { container } = render(<MarkdownLite text={text} />);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PortalConfigProvider } from "@/components/providers/portal-config-provider";
import { PortalNotConfiguredError, portalApiBase, setPortalApiBase } from "@/lib/portal/client";

/* The platform injects `Quix__Portal__Api` into the Next SERVER process.
   `app/layout.tsx` reads it and this provider carries the value into the
   browser bundle. These tests pin that crossing. */

const PORTAL_API = "https://portal-api.dev.quix.io";

afterEach(() => {
  setPortalApiBase(null);
});

describe("PortalConfigProvider carries the server value into the browser", () => {
  it("makes portalApiBase answer with the value it received", () => {
    render(
      <PortalConfigProvider base={PORTAL_API}>
        <span>child</span>
      </PortalConfigProvider>,
    );

    expect(portalApiBase()).toBe(PORTAL_API);
    expect(screen.getByText("child")).toBeInTheDocument();
  });

  it("sets the value before a child renders, never in an effect", () => {
    // A child effect runs before a parent effect, and `usePortalAuth` reads
    // the Portal origin in a child effect on mount. So this child proves the
    // value is present during the child's own render.
    let seenDuringChildRender = "";

    function Child() {
      seenDuringChildRender = portalApiBase();
      return <span>child</span>;
    }

    render(
      <PortalConfigProvider base={PORTAL_API}>
        <Child />
      </PortalConfigProvider>,
    );

    expect(seenDuringChildRender).toBe(PORTAL_API);
  });

  it("leaves the app with no Portal when the server read an empty value", () => {
    // The local stack sets no Portal. The mode must stay off, and it must not
    // fall back to a host.
    render(
      <PortalConfigProvider base="">
        <span>child</span>
      </PortalConfigProvider>,
    );

    expect(() => portalApiBase()).toThrow(PortalNotConfiguredError);
  });
});

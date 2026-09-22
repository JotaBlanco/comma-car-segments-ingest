import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/* The front end runs a server, so it reads the platform variable on the server
   and hands the value to the browser. This file reads the source and pins that
   wiring. A behavior test cannot see it: `app/layout.tsx` imports
   `next/font/google`, so no unit test renders it. */

const FRONTEND_ROOT = fileURLToPath(new URL("../../", import.meta.url));

function read(relative: string): string {
  return readFileSync(join(FRONTEND_ROOT, relative), "utf8");
}

/**
 * Return one file with every comment removed.
 *
 * The history of both retired names lives in the comments of
 * `lib/portal/client.ts`, on purpose. A raw text scan would read that history
 * as a use. A URL sits inside a string in the middle of a line, so a line that
 * STARTS with `//` is a comment and a URL is not.
 */
function withoutComments(text: string): string {
  const noBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return noBlocks
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

/** Every source file of the browser bundle and the server. Tests excluded. */
function sourceFiles(): string[] {
  const found: string[] = [];
  for (const top of ["app", "lib", "components"]) {
    walk(join(FRONTEND_ROOT, top));
  }
  return found;

  function walk(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
        continue;
      }
      if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) found.push(full);
    }
  }
}

describe("the Next server reads the injected Portal variable", () => {
  const layout = read("app/layout.tsx");

  it("reads Quix__Portal__Api, the name the platform injects", () => {
    // `plans/reference/QUIX-INJECTED-VARIABLES.md` cites
    // `DeploymentService.cs:2173`: every deployment gets this plain variable.
    expect(layout).toContain("process.env.Quix__Portal__Api");
  });

  it("passes the value to the provider that reaches the browser", () => {
    expect(layout).toContain("PortalConfigProvider");
    expect(layout).toMatch(/<PortalConfigProvider base=\{portalApiBase\}>/);
  });

  it("renders on every request, so the value is never baked at build time", () => {
    // A statically prerendered layout reads a server variable at BUILD time.
    // That is the same fault the `NEXT_PUBLIC_` name had: one image would
    // carry one environment. `connection()` stops the prerender, and Next 16
    // dropped `export const dynamic` from the route segment config table.
    expect(layout).toContain('import { connection } from "next/server"');
    expect(layout).toMatch(/await connection\(\);[\s\S]*process\.env\.Quix__Portal__Api/);
  });

  it("hands the value to the plain module the browser code reads", () => {
    const provider = read("components/providers/portal-config-provider.tsx");

    expect(provider).toContain("setPortalApiBase(base)");
  });
});

describe("no build-time name survives", () => {
  it("names NEXT_PUBLIC_QUIX_PORTAL_API in no source file", () => {
    const offenders = sourceFiles().filter((path) =>
      withoutComments(readFileSync(path, "utf8")).includes("NEXT_PUBLIC_QUIX_PORTAL_API"),
    );

    expect(offenders).toEqual([]);
  });

  it("names the host that does not exist in no source file", () => {
    // `portal-api.platform.quix.io` was the old default. Production is
    // `portal-api.cloud.quix.io`.
    const offenders = sourceFiles().filter((path) =>
      withoutComments(readFileSync(path, "utf8")).includes("portal-api.platform.quix.io"),
    );

    expect(offenders).toEqual([]);
  });

  it("adds no build argument for the Portal to the image", () => {
    const dockerfile = read("dockerfile");

    expect(dockerfile).not.toContain("QUIX_PORTAL");
    expect(dockerfile).not.toContain("Quix__Portal__Api");
  });
});

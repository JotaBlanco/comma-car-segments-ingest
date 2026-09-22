/**
 * The actor of a manual write comes from the signed-in Quix Portal identity.
 *
 * A behavior test proves what one control sends. This file guards the whole
 * front end instead: it reads the source and fails when any file names an
 * actor by hand. `api/api/provenance.py` refuses a placeholder name, so a
 * literal here produces a journal entry that names nobody, or a 422.
 *
 * Config: `vitest.unit.config.ts` takes `tests/unit/**`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SCANNED = ["lib", "components", "app"];

/**
 * `lib/mock` is the demo database and its seed. It stores journal rows that
 * already carry a name, the way Mongo stores them. It sends no request, so a
 * name there is stored data and never a claimed identity.
 */
const SKIPPED = join("lib", "mock");

/** Every `.ts`/`.tsx` file under the scanned folders. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const path = join(directory, entry);
      if (path.includes(SKIPPED)) continue;
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (entry.endsWith(".ts") || entry.endsWith(".tsx")) found.push(path);
    }
  };
  for (const folder of SCANNED) walk(join(ROOT, folder));
  return found;
}

const FILES = sourceFiles();

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function relative(path: string): string {
  return path.slice(ROOT.length + 1).replaceAll("\\", "/");
}

describe("no file names a write actor by hand", () => {
  it("holds no DEMO_ACTOR symbol anywhere", () => {
    const holders = FILES.filter((path) => read(path).includes("DEMO_ACTOR")).map(relative);
    expect(holders).toEqual([]);
  });

  it("assigns no string literal to an actor key", () => {
    // Matches `actor: "someone"` and `actor: 'someone'`, in a body or a call.
    const pattern = /\bactor:\s*["'`]/;
    const holders = FILES.filter((path) => pattern.test(read(path))).map(relative);
    expect(holders).toEqual([]);
  });

  it("keeps `useActor` as the one place the name comes from", () => {
    const source = read(join(ROOT, "lib", "hooks", "use-actor.ts"));
    // It reads the Portal profile and nothing else.
    expect(source).toContain("usePortalUser");
    // It refuses the placeholder name the Portal client falls back to.
    expect(source).toContain("quix user");
  });

  it("gives every write hook an actor argument with no default", () => {
    const hooks = ["use-runs.ts", "use-signals.ts"].map((name) =>
      read(join(ROOT, "lib", "hooks", name)),
    );
    for (const source of hooks) {
      // Every write hook takes `actor: string | null` and calls `requireActor`.
      expect(source).toContain("actor: string | null");
      expect(source).toContain("requireActor(actor)");
    }
  });
});

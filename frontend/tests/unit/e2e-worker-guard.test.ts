import { describe, expect, it } from "vitest";

import assertSingleWorker from "@/e2e/global-setup";

/**
 * The guard that stops a `--workers=2` e2e run. See `e2e/global-setup.ts`.
 */
describe("the e2e single-worker guard", () => {
  it("lets a one-worker run through", () => {
    expect(() => assertSingleWorker({ workers: 1 })).not.toThrow();
  });

  it("refuses two workers", () => {
    expect(() => assertSingleWorker({ workers: 2 })).toThrow(
      /Playwright resolved 2 workers/,
    );
  });

  it("says why, so the reader does not hunt a phantom regression", () => {
    let message = "";
    try {
      assertSingleWorker({ workers: 4 });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("ONE process-global object");
    expect(message).toContain("resetDb");
    expect(message).toContain("lib/mock/db.ts:79");
    expect(message).toContain("--workers");
  });
});

import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    // Capped at 4: several agents run suites at once in separate worktrees.
    maxWorkers: 4,
    // `tests/ready-names-backend.test.ts` sits beside the folder, not inside it,
    // because plans/PLAN-AFTER-REVIEW.md names that path. Without this second
    // pattern no config picks the file up and the suite never runs it.
    include: [
      "tests/unit/**/*.test.ts",
      // The Flight Test Station's own suite, copied with its code (`station/`).
      "station/**/*.test.ts",
      "tests/providers/**/*.test.ts",
      "tests/ready-names-backend.test.ts",
    ],
    environment: "node",
  },
});

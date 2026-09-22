// Config for the contract guard tests only. See tests/contract.golden.test.ts.
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname) },
  },
  test: {
    // Capped at 4: several agents run suites at once in separate worktrees.
    maxWorkers: 4,
    include: ["tests/contract*.test.ts"],
    environment: "node",
  },
});

// Shared helpers for the mock-db unit suite. Not a test file (no .test.ts
// suffix) so vitest.unit.config.ts does not collect it.

import { expect } from "vitest";
import { MockDbError } from "@/lib/mock/errors";
import type { Pagination } from "@/lib/mock/helpers";

/** Pagination shorthand — page_size 50 fits every seeded list on one page. */
export function page(pageNumber = 1, pageSize = 50): Pagination {
  return { page: pageNumber, pageSize };
}

/**
 * Asserts that `fn` throws a MockDbError with the given HTTP status and
 * machine code (contract §A error envelope), and returns it for further
 * assertions on `detail` / `errors`.
 */
export function expectMockDbError(fn: () => unknown, status: number, code: string): MockDbError {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected a MockDbError(${status} ${code}) to be thrown`).toBeInstanceOf(MockDbError);
  const err = caught as MockDbError;
  expect(err.status).toBe(status);
  expect(err.code).toBe(code);
  return err;
}

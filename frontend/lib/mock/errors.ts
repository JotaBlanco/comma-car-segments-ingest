export class MockDbError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly detail: string,
    public readonly errors: unknown[] = [],
  ) {
    super(detail);
    this.name = "MockDbError";
  }
}

export function notFound(code: string, detail: string): MockDbError {
  return new MockDbError(404, code, detail);
}

export function validation(code: string, detail: string, errors: unknown[] = []): MockDbError {
  return new MockDbError(422, code, detail, errors);
}

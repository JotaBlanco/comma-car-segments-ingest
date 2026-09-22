// Unprefixed, unauthenticated liveness probe (API-CONTRACT.md §A).
export function GET(): Response {
  return Response.json({ status: "ok" });
}

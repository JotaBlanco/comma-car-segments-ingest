import { NextResponse } from "next/server";
import { resetDb } from "@/lib/mock/db";

export async function POST(): Promise<NextResponse> {
  if (process.env.TM_TEST_HOOKS !== "1") {
    return NextResponse.json(
      { detail: "not found", code: "not_found", errors: [] },
      { status: 404 },
    );
  }
  resetDb();
  return NextResponse.json({ reset: true });
}

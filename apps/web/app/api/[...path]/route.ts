import { NextRequest, NextResponse } from "next/server";
import { fujiGet } from "@/lib/evm/fuji-api";
// Legacy alias: the same read-only Fuji chain adapter serves these routes.
// There is no NEAR transport anywhere in this application.
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  const { status, body } = await fujiGet(request.nextUrl);
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export function POST() {
  return NextResponse.json({ error: "Mutations require a wallet-signed Fuji transaction" }, { status: 405, headers: { Allow: "GET" } });
}

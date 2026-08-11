import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const emails = (process.env.NEXT_PUBLIC_ADMIN_EMAILS || "")
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

  return NextResponse.json({ emails });
}

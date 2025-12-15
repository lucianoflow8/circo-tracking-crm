import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const r = await prisma.$queryRaw<
    { current_user: string; current_schema: string; current_database: string }[]
  >`select current_user, current_schema(), current_database();`;

  return NextResponse.json(r[0]);
}

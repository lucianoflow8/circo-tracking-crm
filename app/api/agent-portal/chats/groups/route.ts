import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({} as any));

  if (!body?.name) {
    return NextResponse.json(
      { error: "Falta el nombre del grupo" },
      { status: 400 }
    );
  }

  try {
    const res = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(DEFAULT_LINE_ID)}/groups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // 👉 acá mandamos TODO el payload (name, participants, admins, avatar, etc.)
        body: JSON.stringify(body),
      }
    );

    const data = await res.json().catch(() => ({} as any));

    if (!res.ok) {
      console.error("[agent-portal/chats/groups POST] Error WA-SERVER:", data);
      return NextResponse.json(
        { error: data.error || "No se pudo crear el grupo" },
        { status: res.status || 500 }
      );
    }

    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats/groups POST] Excepción:", e);
    return NextResponse.json(
      { error: e.message || "No se pudo crear el grupo" },
      { status: 500 }
    );
  }
}
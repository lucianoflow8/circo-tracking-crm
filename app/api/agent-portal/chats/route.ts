// app/api/agent-portal/chats/route.ts
import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

if (!WA_SERVER_URL) {
  console.warn("[agent-portal/chats] Falta WA_SERVER_URL en env");
}
if (!DEFAULT_LINE_ID) {
  console.warn("[agent-portal/chats] Falta WA_DEFAULT_LINE_ID en env");
}

// 👇 Versión sin validación de token en Prisma.
// Acepta cualquier token, solo usa WA_DEFAULT_LINE_ID.
export async function GET(req: NextRequest) {
  try {
    if (!DEFAULT_LINE_ID) {
      return NextResponse.json(
        { chats: [], error: "No hay WA_DEFAULT_LINE_ID configurado" },
        { status: 500 }
      );
    }

    // (Opcional) leemos el token, pero NO lo usamos.
    const token = req.nextUrl.searchParams.get("token") || "";
    console.log("[agent-portal/chats] Token recibido (ignorado por ahora):", token);

    const res = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(DEFAULT_LINE_ID)}/chats`,
      { method: "GET" }
    );

    const data = await res.json().catch(() => ({} as any));

    if (!res.ok) {
      console.error("[agent-portal/chats] Error WA-SERVER:", data);
      return NextResponse.json(
        { chats: [], error: "No se pudieron cargar los chats" },
        { status: 500 }
      );
    }

    const chats = Array.isArray(data) ? data : data.chats || [];

    return NextResponse.json({ chats }, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats] Excepción:", e);
    return NextResponse.json(
      { chats: [], error: "Error interno al cargar chats" },
      { status: 500 }
    );
  }
}
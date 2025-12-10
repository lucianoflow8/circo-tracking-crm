// app/api/agent-portal/chats/[chatId]/read/route.ts
import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

if (!WA_SERVER_URL) {
  console.warn("[agent-portal/read] Falta WA_SERVER_URL en env");
}
if (!DEFAULT_LINE_ID) {
  console.warn("[agent-portal/read] Falta WA_DEFAULT_LINE_ID en env");
}

// 👇 IMPORTANTE: en Next 16 los params vienen como Promise
type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { chatId: rawChatId } = await ctx.params;
    const chatId = decodeURIComponent(rawChatId || "");

    if (!DEFAULT_LINE_ID) {
      return NextResponse.json(
        { error: "WA_DEFAULT_LINE_ID no configurado" },
        { status: 500 }
      );
    }

    if (!chatId) {
      return NextResponse.json(
        { error: "chatId requerido" },
        { status: 400 }
      );
    }

    console.log(
      "[agent-portal/chats/[chatId]/read] Marcando como leído → lineId=",
      DEFAULT_LINE_ID,
      "chatId=",
      chatId
    );

    const res = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(
        DEFAULT_LINE_ID
      )}/chats/${encodeURIComponent(chatId)}/read`,
      {
        method: "POST",
      }
    );

    const data = await res.json().catch(() => ({} as any));

    if (!res.ok) {
      console.error(
        "[agent-portal/chats/[chatId]/read] Error WA-SERVER:",
        data
      );
      return NextResponse.json(
        { error: data.error || "No se pudo marcar el chat como leído" },
        { status: 500 }
      );
    }

    // data debería ser { ok: true }
    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats/[chatId]/read] Excepción:", e);
    return NextResponse.json(
      { error: e?.message || "Error interno" },
      { status: 500 }
    );
  }
}
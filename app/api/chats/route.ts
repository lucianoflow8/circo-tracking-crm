// app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || "";
const WA_DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

if (!WA_SERVER_URL) {
  console.warn("[API/CHATS] Falta WA_SERVER_URL en env");
}
if (!WA_DEFAULT_LINE_ID) {
  console.warn(
    "[API/CHATS] WA_DEFAULT_LINE_ID está vacío (se usará sólo cuando no venga ?lineId=)"
  );
}

// GET /api/chats?lineId=xxxx
export async function GET(req: NextRequest) {
  try {
    if (!WA_SERVER_URL) {
      return NextResponse.json(
        { error: "WA_SERVER_URL no configurado" },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const lineIdFromQuery = url.searchParams.get("lineId");

    // 1) Si viene ?lineId= en la URL, usamos ese
    let effectiveLineId: string | null = lineIdFromQuery;

    // 2) Fallback: WA_DEFAULT_LINE_ID
    if (!effectiveLineId && WA_DEFAULT_LINE_ID) {
      effectiveLineId = WA_DEFAULT_LINE_ID;
    }

    if (!effectiveLineId) {
      return NextResponse.json(
        {
          error:
            "No se indicó lineId y WA_DEFAULT_LINE_ID está vacío. Configurá la línea.",
        },
        { status: 400 }
      );
    }

    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(
      effectiveLineId
    )}/chats`;

    const res = await fetch(waUrl, { cache: "no-store" });
    const text = await res.text();

    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      console.error("[API/CHATS] Error WA-SERVER:", res.status, data);

      // Caso especial: la sesión de esa línea no está conectada
      if (res.status === 404 && data?.error === "Session not found") {
        return NextResponse.json(
          {
            chats: [],
            info:
              "La sesión de WhatsApp para esta línea no está conectada (Session not found).",
          },
          { status: 200 }
        );
      }

      return NextResponse.json(
        {
          error: "Error al obtener chats desde WA-SERVER",
          waStatus: res.status,
          waBody: data,
        },
        { status: 500 }
      );
    }

    const waChats: any[] = Array.isArray(data) ? data : data.chats || [];

    const chats = waChats.map((c) => {
      const rawId: string =
        c.id?._serialized || c.waChatId || c.id || String(c.chatId || "");

      const isGroup =
        !!c.isGroup ||
        rawId.endsWith("@g.us") ||
        (c.id && String(c.id).includes("@g.us"));

      let phone: string | null = null;
      if (!isGroup) {
        const match =
          rawId.match(/^(\d+)(@c\.us)?$/) ||
          rawId.match(/^(\d+)(-|@)/) ||
          rawId.match(/(\d+)/);
        phone = match ? match[1] : null;
      }

      const name = (() => {
        if (isGroup) {
          return (
            c.name ||
            c.formattedTitle ||
            (c.groupMetadata && c.groupMetadata.subject) ||
            "Grupo sin nombre"
          );
        }
        return (
          c.name ||
          c.pushname ||
          c.formattedTitle ||
          (c.contact &&
            (c.contact.name ||
              c.contact.pushname ||
              c.contact.shortName)) ||
          phone ||
          "Sin nombre"
        );
      })();

      return {
        id: rawId,
        waChatId: rawId,
        name,
        isGroup,
        phone,
        lastMessage: c.lastMessage ?? "",
        lastMessageAt: c.lastMessageAt ?? null,
        lastTimestampMs: c.lastTimestampMs ?? null,
        unreadCount: c.unreadCount ?? 0,
        lastMessageFromMe: c.lastMessageFromMe ?? false,
        lastMessageStatus: c.lastMessageStatus ?? null,
        profilePicUrl:
          c.profilePicUrl || c.avatarUrl || c.photoUrl || null,
      };
    });

    return NextResponse.json({ chats }, { status: 200 });
  } catch (err) {
    console.error("[API/CHATS] Error interno:", err);
    return NextResponse.json(
      { error: "Error interno al obtener chats" },
      { status: 500 }
    );
  }
}
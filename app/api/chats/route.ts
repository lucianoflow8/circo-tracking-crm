// app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

// GET /api/chats
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const lineId = searchParams.get("lineId") || DEFAULT_LINE_ID;

    if (!WA_SERVER_URL || !lineId) {
      console.error(
        "[API/CHATS] Faltan variables. WA_SERVER_URL:",
        WA_SERVER_URL,
        "lineId:",
        lineId
      );
      return NextResponse.json(
        { error: "Configuración incompleta en el servidor" },
        { status: 500 }
      );
    }

    const url = `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats`;
    console.log("[API/CHATS] Llamando a WA-SERVER:", url);

    const res = await fetch(url, { cache: "no-store" });

    const raw = await res.text(); // leemos siempre como texto para loguear
    if (!res.ok) {
      console.error(
        "[API/CHATS] Error WA-SERVER:",
        res.status,
        raw || "<sin cuerpo>"
      );

      let waBody: any = null;
      try {
        waBody = raw ? JSON.parse(raw) : null;
      } catch {
        waBody = raw;
      }

      return NextResponse.json(
        {
          error: "Error al obtener chats desde WA-SERVER",
          waStatus: res.status,
          waBody,
        },
        { status: 500 }
      );
    }

    // Si vino OK, parseamos como JSON
    let data: any = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (e) {
      console.error("[API/CHATS] No se pudo parsear JSON de WA-SERVER:", e);
      return NextResponse.json(
        { error: "Respuesta inválida de WA-SERVER" },
        { status: 500 }
      );
    }

    const waChats: any[] = data.chats || [];

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

    return NextResponse.json({ chats });
  } catch (err: any) {
    console.error("[API/CHATS] Error interno:", err);
    return NextResponse.json(
      {
        error: "Error interno al obtener chats",
        detail: err?.message ?? null,
      },
      { status: 500 }
    );
  }
}

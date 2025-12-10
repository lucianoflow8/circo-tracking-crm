// app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID!;

// GET /api/chats
export async function GET(_req: NextRequest) {
  try {
    if (!WA_SERVER_URL || !DEFAULT_LINE_ID) {
      console.error("[API/CHATS] Faltan WA_SERVER_URL o WA_DEFAULT_LINE_ID");
      return NextResponse.json(
        { error: "Configuración incompleta" },
        { status: 500 }
      );
    }

    const url = `${WA_SERVER_URL}/lines/${encodeURIComponent(
      DEFAULT_LINE_ID
    )}/chats`;

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const text = await res.text();
      console.error("[API/CHATS] Error WA-SERVER:", res.status, text);
      return NextResponse.json(
        { error: "Error al obtener chats desde WA-SERVER" },
        { status: 500 }
      );
    }

    const data = await res.json();
    const waChats: any[] = data.chats || [];

    const chats = waChats.map((c) => {
      // id real de WhatsApp (incluye @c.us o @g.us)
      const rawId: string =
        c.id?._serialized || c.waChatId || c.id || String(c.chatId || "");

      const isGroup =
        !!c.isGroup ||
        rawId.endsWith("@g.us") ||
        (c.id && String(c.id).includes("@g.us"));

      // Teléfono solo para chats individuales
      let phone: string | null = null;
      if (!isGroup) {
        const match =
          rawId.match(/^(\d+)(@c\.us)?$/) ||
          rawId.match(/^(\d+)(-|@)/) ||
          rawId.match(/(\d+)/);
        phone = match ? match[1] : null;
      }

      // Nombre amigable
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
        id: rawId, // 👈 MUY IMPORTANTE: usamos el id real (incluye @g.us en grupos)
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
  } catch (err) {
    console.error("[API/CHATS] Error interno:", err);
    return NextResponse.json(
      { error: "Error interno al obtener chats" },
      { status: 500 }
    );
  }
}
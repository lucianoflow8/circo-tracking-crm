// app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const WA_DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || null;

// GET /api/chats?lineId=xxxxx   (opcional)
export async function GET(req: NextRequest) {
  try {
    if (!WA_SERVER_URL) {
      console.error("[API/CHATS] FALTA WA_SERVER_URL en el .env");
      return NextResponse.json(
        { error: "Servidor de WhatsApp no configurado" },
        { status: 500 }
      );
    }

    // 1) Usuario actual
    const userId = await getCurrentUserId().catch(() => null);

    // 2) Tomamos ?lineId= de la query si viene
    const urlReq = new URL(req.url);
    const queryLineId = urlReq.searchParams.get("lineId");

    let effectiveLineId: string | null = null;

    // ========= PRIORIDAD 1: línea explícita en la query, pero validando dueño =========
    if (userId && queryLineId) {
      const line = await prisma.whatsappLine.findFirst({
        where: {
          id: queryLineId,
          userId,
        },
        select: { id: true },
      });

      if (!line) {
        return NextResponse.json(
          {
            error: "Línea no encontrada o no pertenece al usuario",
          },
          { status: 404 }
        );
      }

      effectiveLineId = line.id;
    }

    // ========= PRIORIDAD 2: primera línea del usuario logueado =========
    if (userId && !effectiveLineId) {
      const firstLine = await prisma.whatsappLine.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });

      if (firstLine) {
        effectiveLineId = firstLine.id;
      }
    }

    // ========= PRIORIDAD 3: fallback al WA_DEFAULT_LINE_ID =========
    if (!effectiveLineId) {
      if (!WA_DEFAULT_LINE_ID) {
        // No hay línea del usuario ni fallback
        return NextResponse.json(
          {
            chats: [],
            info:
              "Sin líneas de WhatsApp asociadas a este usuario y sin WA_DEFAULT_LINE_ID",
          },
          { status: 200 }
        );
      }

      // Pensado para vos: tu cuenta Flow principal
      effectiveLineId = WA_DEFAULT_LINE_ID;
    }

    // ========= Llamar al WA-SERVER con la línea efectiva =========
    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(
      effectiveLineId
    )}/chats`;

    const res = await fetch(waUrl, { cache: "no-store" });

    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }

    if (!res.ok) {
      console.error(
        "[API/CHATS] Error WA-SERVER:",
        res.status,
        bodyText || "(sin body)"
      );

      // Intentamos parsear JSON por si viene { error: "Session not found" }
      let parsed: any = {};
      try {
        parsed = bodyText ? JSON.parse(bodyText) : {};
      } catch {
        parsed = {};
      }

      return NextResponse.json(
        {
          error: "Error al obtener chats desde WA-SERVER",
          waStatus: res.status,
          waBody: parsed,
        },
        { status: 500 }
      );
    }

    // Si ok, parseamos como JSON
    let data: any = {};
    try {
      data = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      data = {};
    }

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
        id: rawId, // 👈 usamos el id real (incluye @g.us en grupos)
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

    return NextResponse.json({ chats, lineId: effectiveLineId });
  } catch (err) {
    console.error("[API/CHATS] Error interno:", err);
    return NextResponse.json(
      { error: "Error interno al obtener chats" },
      { status: 500 }
    );
  }
}
// app/api/chats/[chatId]/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID!;

// Helper params (soporta objeto o Promise)
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

const toDigits = (value: string | null | undefined) =>
  (value || "").replace(/\D/g, "");

// ========= GET: devuelve mensajes desde CrmMessage =========
// ========= GET: intenta traer mensajes con media desde WA-SERVER;
// si falla, usa solo los textos guardados en CrmMessage =========
export async function GET(
  _req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  const { chatId } = await unwrapParams(context.params);
  const phone = toDigits(chatId);

  if (!phone) {
    return NextResponse.json({ messages: [] }, { status: 200 });
  }

  // 👤 usuario dueño
  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  // ===== 1) Intentar leer directo del WA-SERVER (con media) =====
  const jid = `${phone}@c.us`;

  // buscamos la última línea con la que habló este teléfono (igual que en el POST)
  let lineId = DEFAULT_LINE_ID;
  try {
    const lastMsg = await prisma.crmMessage.findFirst({
      where: {
        phone,
        ownerId: userId,
      },
      orderBy: { createdAt: "desc" },
    });
    if (lastMsg?.lineId) {
      lineId = lastMsg.lineId;
    }
  } catch (err) {
    console.error(
      "[API/CHAT MESSAGES GET] Error buscando línea para phone",
      phone,
      err
    );
  }

  let waMessages: any[] | null = null;

  try {
    const waRes = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(
        lineId
      )}/chats/${encodeURIComponent(jid)}/messages`
    );

    if (waRes.ok) {
      const waData = await waRes.json();
      waMessages = waData.messages || [];
    } else {
      const text = await waRes.text();
      console.error(
        "[API/CHAT MESSAGES GET] WA-SERVER messages error:",
        waRes.status,
        text.slice(0, 300)
      );
    }
  } catch (err) {
    console.error(
      "[API/CHAT MESSAGES GET] Error llamando a WA-SERVER",
      err
    );
  }

  // Si WA-SERVER respondió bien, usamos esos mensajes (ya vienen con media, tipo, estado, etc.)
  if (waMessages && waMessages.length) {
    // nos aseguramos que vengan ordenados por fecha ascendente
    waMessages.sort(
      (a: any, b: any) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
    return NextResponse.json({ messages: waMessages }, { status: 200 });
  }

  // ===== 2) Fallback: sólo textos desde CrmMessage (sin media) =====
  try {
    const rows = await prisma.crmMessage.findMany({
      where: {
        phone,
        ownerId: userId,
      },
      orderBy: { createdAt: "asc" },
    });

    const messages = rows.map((row) => {
      return {
        id: row.waMessageId || row.id,
        fromMe: row.direction === "out",
        body: row.body || "",
        timestamp: row.createdAt.toISOString(),
        status: row.direction === "out" ? ("sent" as const) : undefined,
        type: (row.msgType as any) || "text",
        media: null, // sin media en fallback
        senderName: undefined,
        senderNumber: row.phone,
        senderAvatar: null,
      };
    });

    return NextResponse.json({ messages }, { status: 200 });
  } catch (err) {
    console.error("Error /api/chats/[chatId]/messages GET (fallback)", err);
    return NextResponse.json({ messages: [] }, { status: 200 });
  }
}
// ========= POST: enviar mensaje Y guardarlo en CrmMessage =========
export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);
    const bodyJson = await req.json();
    const { body, media } = bodyJson || {};

    // Aceptamos mensaje sólo texto, sólo media o ambos
    if ((!body || typeof body !== "string") && !media) {
      return NextResponse.json(
        { error: "Se requiere body (texto) o media" },
        { status: 400 }
      );
    }

    const phone = toDigits(chatId);
    if (!phone) {
      return NextResponse.json(
        { error: "chatId inválido" },
        { status: 400 }
      );
    }

    // 👤 usuario dueño
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    // Elegimos la línea: última con la que habló este teléfono (de este dueño)
    let lineId = DEFAULT_LINE_ID;
    try {
      const lastMsg = await prisma.crmMessage.findFirst({
        where: {
          phone,
          ownerId: userId,
        },
        orderBy: { createdAt: "desc" },
      });
      if (lastMsg?.lineId) {
        lineId = lastMsg.lineId;
      }
    } catch (err) {
      console.error(
        "[API/CHAT MESSAGES POST] Error buscando línea para phone",
        phone,
        err
      );
    }

    const jid = `${phone}@c.us`;

    // 1) Enviamos al WA-SERVER
    const waRes = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(
        lineId
      )}/chats/${encodeURIComponent(jid)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, media }),
      }
    );

    if (!waRes.ok) {
      const text = await waRes.text();
      console.error(
        "WA-SERVER messages POST error:",
        waRes.status,
        text
      );

      return NextResponse.json(
        { error: "Error al enviar mensaje a WA-SERVER" },
        { status: 500 }
      );
    }

    let waData: any = null;
    try {
      waData = await waRes.json();
    } catch {
      waData = null;
    }

    // 2) Determinar tipo de mensaje
    let msgType: string = "text";
    if (media) {
      const mt: string = media.mimetype || "";
      if (mt.startsWith("image/")) msgType = "image";
      else if (mt.startsWith("audio/")) msgType = "audio";
      else if (mt === "application/pdf" || mt.startsWith("application/"))
        msgType = "document";
      else msgType = "media";
    }

    // 3) ID de WhatsApp estable (para evitar duplicados)
    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id ||
          waData.message?.id ||
          waData.messageId ||
          waData.key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // 4) Guardar / actualizar en CrmMessage (por si el WA-SERVER también guarda)
    const created = await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        phone,
        ownerId: userId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        rawPayload: JSON.stringify(waData ?? null),
      },
      create: {
        phone,
        ownerId: userId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        waMessageId,
        rawPayload: JSON.stringify(waData ?? null),
      },
    });

    // 5) Normalizar para el front exactamente igual que en el GET
    const saved = {
      id: created.waMessageId || created.id,
      fromMe: true,
      body: created.body || "",
      timestamp: created.createdAt.toISOString(),
      status: "sent" as const,
      type: (created.msgType as any) || "text",
      media: media ?? null, // si era media y venía del front, la reutilizamos
      senderName: undefined,
      senderNumber: created.phone,
      senderAvatar: null,
    };

    return NextResponse.json({ message: saved }, { status: 200 });
  } catch (err: any) {
    console.error("Error /api/chats/[chatId]/messages POST", err);
    return NextResponse.json(
      { error: err?.message || "Error interno al enviar mensaje" },
      { status: 500 }
    );
  }
}
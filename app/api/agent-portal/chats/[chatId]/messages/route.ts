// app/api/agent-portal/chats/[chatId]/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID!;

async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

const toDigits = (value: string | null | undefined) => (value || "").replace(/\D/g, "");

async function ensureConnected(lineId: string, ownerId: string) {
  try {
    await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId }),
    }).catch(() => null);
  } catch {}
}

async function getPortalFromToken(token: string) {
  const { data: portal, error } = await supabaseAdmin
    .from("agent_portals")
    .select("id, owner_user_id, line_ids, enabled")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("[agent-portal/messages] Error select portal:", error);
    return { portal: null as any, error: "No se pudo leer el portal" };
  }

  if (!portal || portal.enabled === false) {
    return { portal: null as any, error: "Portal inexistente o deshabilitado" };
  }

  return { portal, error: null as string | null };
}

function pickLineId(portal: any, lineIdParam: string | null) {
  const lineIds: string[] = (portal?.line_ids || []) as string[];
  if (Array.isArray(lineIds) && lineIds.length > 0) {
    if (lineIdParam && lineIds.includes(lineIdParam)) return lineIdParam;
    return lineIds[0];
  }
  return lineIdParam || DEFAULT_LINE_ID;
}

function buildJidFromChatId(chatIdRaw: string) {
  const chatId = decodeURIComponent(chatIdRaw || "");

  // Si ya viene como jid (ej: 549...@c.us o 1203...@g.us) lo respetamos
  if (chatId.includes("@g.us")) {
    return { jid: chatId, phone: null, isGroup: true };
  }
  if (chatId.includes("@c.us")) {
    const phone = toDigits(chatId);
    return { jid: chatId, phone, isGroup: false };
  }

  // fallback: si vino como solo números
  const phone = toDigits(chatId);
  return { jid: phone ? `${phone}@c.us` : "", phone: phone || null, isGroup: false };
}

/* ============================================================
   GET: leer mensajes (WA-SERVER si puede, fallback CrmMessage)
   ============================================================ */
export async function GET(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const lineIdParam = url.searchParams.get("lineId");

    if (!token) {
      return NextResponse.json({ error: "Falta token" }, { status: 400 });
    }

    const { portal, error } = await getPortalFromToken(token);
    if (error || !portal) {
      return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });
    }

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);

    const { jid, phone, isGroup } = buildJidFromChatId(chatId);
    if (!jid) return NextResponse.json({ messages: [] }, { status: 200 });

    // 1) Intentar WA-SERVER (con media)
    let waMessages: any[] | null = null;

    try {
      let waRes = await fetch(
        `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
        { cache: "no-store" }
      );

      // Session not found => autoconnect + retry 1 vez
      if (!waRes.ok) {
        const text = await waRes.text().catch(() => "");
        if (waRes.status === 404 && text.includes("Session not found") && ownerId) {
          await ensureConnected(lineId, ownerId);
          waRes = await fetch(
            `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
            { cache: "no-store" }
          );
        }
      }

      if (waRes.ok) {
        const waData = await waRes.json().catch(() => ({} as any));
        waMessages = waData.messages || [];
      } else {
        const text = await waRes.text().catch(() => "");
        console.error("[agent-portal/messages GET] WA-SERVER error", waRes.status, text.slice(0, 300));
      }
    } catch (err) {
      console.error("[agent-portal/messages GET] Error llamando a WA-SERVER", err);
    }

    if (waMessages && waMessages.length) {
      waMessages.sort(
        (a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      return NextResponse.json({ messages: waMessages }, { status: 200 });
    }

    // 2) Fallback DB (solo chats individuales): ownerId + lineId + phone
    if (isGroup || !phone) {
      return NextResponse.json({ messages: [] }, { status: 200 });
    }

    const rows = await prisma.crmMessage.findMany({
      where: { ownerId, lineId, phone },
      orderBy: { createdAt: "asc" },
      take: 300,
    });

    const messages = rows.map((row) => ({
      id: row.waMessageId || row.id,
      fromMe: row.direction === "out",
      body: row.body || "",
      timestamp: row.createdAt.toISOString(),
      status: row.direction === "out" ? ("sent" as const) : undefined,
      type: (row.msgType as any) || "text",
      media: row.mediaDataUrl
        ? {
            dataUrl: row.mediaDataUrl,
            fileName: row.mediaFileName,
            mimetype: row.mediaMimeType,
          }
        : null,
      senderName: undefined,
      senderNumber: row.phone,
      senderAvatar: null,
    }));

    return NextResponse.json({ messages }, { status: 200 });
  } catch (err) {
    console.error("[agent-portal/messages GET] Error interno", err);
    return NextResponse.json({ messages: [] }, { status: 200 });
  }
}

/* ============================================================
   POST: enviar mensaje desde portal (token) + guardar en CrmMessage
   ============================================================ */
export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const lineIdParam = url.searchParams.get("lineId");

    if (!token) {
      return NextResponse.json({ error: "Falta token" }, { status: 400 });
    }

    const { portal, error } = await getPortalFromToken(token);
    if (error || !portal) {
      return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });
    }

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);

    const bodyJson = await req.json().catch(() => ({} as any));
    const { body, media } = bodyJson || {};

    if ((!body || typeof body !== "string") && !media) {
      return NextResponse.json({ error: "Se requiere body (texto) o media" }, { status: 400 });
    }

    const { jid, phone, isGroup } = buildJidFromChatId(chatId);
    if (!jid) return NextResponse.json({ error: "chatId inválido" }, { status: 400 });

    // Tipo de mensaje (mantengo tu lógica)
    let msgType: string = "text";
    if (media) {
      const mt: string = media.mimetype || "";
      if (mt.startsWith("image/")) msgType = "image";
      else if (mt.startsWith("audio/")) msgType = "audio";
      else if (mt === "application/pdf" || mt.startsWith("application/")) msgType = "document";
      else msgType = "media";
    }

    // Enviar a WA-SERVER
    let waRes = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, media, type: msgType }),
      }
    );

    // Session not found => autoconnect y retry 1 vez
    if (!waRes.ok) {
      const text = await waRes.text().catch(() => "");
      if (waRes.status === 404 && text.includes("Session not found")) {
        await ensureConnected(lineId, ownerId);
        waRes = await fetch(
          `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body, media, type: msgType }),
          }
        );
      }
    }

    if (!waRes.ok) {
      const text = await waRes.text().catch(() => "");
      console.error("[agent-portal/messages POST] WA-SERVER error", waRes.status, text);
      return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
    }

    const waData = await waRes.json().catch(() => null);

    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id || waData.message?.id || waData.messageId || waData.key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Guardar en DB (clave: ownerId + lineId correctos)
    const created = await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        phone: phone || (isGroup ? toDigits(jid) : ""),
        ownerId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        rawPayload: JSON.stringify(waData ?? null),
      },
      create: {
        phone: phone || (isGroup ? toDigits(jid) : ""),
        ownerId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        waMessageId,
        rawPayload: JSON.stringify(waData ?? null),
      },
    });

    const saved = {
      id: created.waMessageId || created.id,
      fromMe: true,
      body: created.body || "",
      timestamp: created.createdAt.toISOString(),
      status: "sent" as const,
      type: (created.msgType as any) || "text",
      media: media ?? null,
      senderName: undefined,
      senderNumber: created.phone,
      senderAvatar: null,
    };

    return NextResponse.json({ message: saved }, { status: 200 });
  } catch (err: any) {
    console.error("[agent-portal/messages POST] Error interno", err);
    return NextResponse.json({ error: err?.message || "Error interno" }, { status: 500 });
  }
}

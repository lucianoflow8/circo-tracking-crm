import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

const toDigits = (value: string | null | undefined) => (value || "").replace(/\D/g, "");

// ✅ Lee el body UNA SOLA VEZ (evita: Body has already been read)
async function readOnce(res: Response) {
  const raw = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = JSON.parse(raw);
  } catch {}
  return { raw, json };
}

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

  // ✅ si no hay líneas, no usamos DEFAULT (evita mezclar)
  if (!Array.isArray(lineIds) || lineIds.length === 0) return null;

  if (lineIdParam && lineIds.includes(lineIdParam)) return lineIdParam;
  return lineIds[0];
}

function buildJidFromChatId(chatIdRaw: string) {
  const chatId = decodeURIComponent(chatIdRaw || "");

  if (chatId.includes("@g.us")) return { jid: chatId, phone: null, isGroup: true };

  if (chatId.includes("@c.us")) {
    const phone = toDigits(chatId.split("@")[0]);
    return { jid: chatId, phone, isGroup: false };
  }

  const phone = toDigits(chatId);
  return { jid: phone ? `${phone}@c.us` : "", phone: phone || null, isGroup: false };
}

export async function GET(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const lineIdParam = url.searchParams.get("lineId");

    // ✅ IMPORTANT: por default SIEMPRE intentamos traer media desde WA
    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10)));
    const includeMedia = (url.searchParams.get("includeMedia") ?? "1").trim() || "1";

    if (!token) return NextResponse.json({ error: "Falta token" }, { status: 400 });

    const { portal, error } = await getPortalFromToken(token);
    if (error || !portal) {
      return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });
    }

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);
    if (!lineId) return NextResponse.json({ messages: [] }, { status: 200 });

    const { jid, phone, isGroup } = buildJidFromChatId(chatId);
    if (!jid) return NextResponse.json({ messages: [] }, { status: 200 });

    const qs = new URLSearchParams({
      limit: String(limit),
      includeMedia, // ✅ passthrough al WA-SERVER
    }).toString();

    const waEndpoint =
      `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}` +
      `/chats/${encodeURIComponent(jid)}/messages?${qs}`;

    // 1) WA-SERVER
    let waMessages: any[] | null = null;

    try {
      let waRes: Response | null = await fetch(waEndpoint, { cache: "no-store" });

      // Si falla, leemos una sola vez para decidir si reintentar
      if (waRes && !waRes.ok) {
        const { raw } = await readOnce(waRes);

        if (waRes.status === 404 && raw.includes("Session not found") && ownerId) {
          await ensureConnected(lineId, ownerId);
          waRes = await fetch(waEndpoint, { cache: "no-store" });
        } else {
          console.error("[agent-portal/messages GET] WA-SERVER error", waRes.status, raw.slice(0, 300));
          waRes = null;
        }
      }

      if (waRes && waRes.ok) {
        const { json } = await readOnce(waRes);
        const arr = (json as any)?.messages;
        waMessages = Array.isArray(arr) ? arr : [];
      }
    } catch (err) {
      console.error("[agent-portal/messages GET] Error llamando a WA-SERVER", err);
    }

    if (waMessages && waMessages.length) {
      waMessages.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
      return NextResponse.json({ messages: waMessages }, { status: 200 });
    }

    // 2) Fallback DB (solo individual)
    if (isGroup || !phone) return NextResponse.json({ messages: [] }, { status: 200 });

    const rows = await prisma.crmMessage.findMany({
      where: { ownerId, lineId, phone },
      orderBy: { createdAt: "asc" },
      take: 300,
    });

    const messages = rows.map((row) => {
      const r: any = row as any;
      const media = r.mediaDataUrl
        ? {
            dataUrl: r.mediaDataUrl,
            fileName: r.mediaFileName || null,
            mimetype: r.mediaMimeType || "application/octet-stream",
          }
        : null;

      return {
        id: row.waMessageId || row.id,
        fromMe: row.direction === "out",
        body: row.body || "",
        timestamp: row.createdAt.toISOString(),
        status: row.direction === "out" ? ("sent" as const) : undefined,
        type: (row.msgType as any) || "text",
        media,
        senderName: undefined,
        senderNumber: row.phone,
        senderAvatar: null,
      };
    });

    return NextResponse.json({ messages }, { status: 200 });
  } catch (err) {
    console.error("[agent-portal/messages GET] Error interno", err);
    return NextResponse.json({ messages: [] }, { status: 200 });
  }
}

export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);

    const url = new URL(req.url);
    const token = url.searchParams.get("token") || "";
    const lineIdParam = url.searchParams.get("lineId");

    if (!token) return NextResponse.json({ error: "Falta token" }, { status: 400 });

    const { portal, error } = await getPortalFromToken(token);
    if (error || !portal) {
      return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });
    }

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);
    if (!lineId) return NextResponse.json({ error: "Portal sin líneas asignadas" }, { status: 400 });

    const bodyJson = await req.json().catch(() => ({} as any));
    const { body, media } = bodyJson || {};

    if ((!body || typeof body !== "string") && !media) {
      return NextResponse.json({ error: "Se requiere body (texto) o media" }, { status: 400 });
    }

    const { jid, phone, isGroup } = buildJidFromChatId(chatId);
    if (!jid) return NextResponse.json({ error: "chatId inválido" }, { status: 400 });

    let msgType: string = "text";
    if (media) {
      const mt: string = media.mimetype || "";
      if (mt.startsWith("image/")) msgType = "image";
      else if (mt.startsWith("audio/")) msgType = "audio";
      else if (mt === "application/pdf" || mt.startsWith("application/")) msgType = "document";
      else msgType = "media";
    }

    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`;

    let waRes: Response = await fetch(waUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // ✅ compat: mandamos text + body (wa-server puede esperar text)
      body: JSON.stringify({ text: body, body, media, type: msgType }),
    });

    if (!waRes.ok) {
      const { raw } = await readOnce(waRes);

      if (waRes.status === 404 && raw.includes("Session not found")) {
        await ensureConnected(lineId, ownerId);
        waRes = await fetch(waUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: body, body, media, type: msgType }),
        });
      } else {
        console.error("[agent-portal/messages POST] WA-SERVER error", waRes.status, raw.slice(0, 300));
        return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
      }
    }

    if (!waRes.ok) {
      const { raw } = await readOnce(waRes);
      console.error("[agent-portal/messages POST] WA-SERVER error (retry)", waRes.status, raw.slice(0, 300));
      return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
    }

    const { json: waData } = await readOnce(waRes);

    const waMessageId: string =
      (waData &&
        ((waData as any).message?.id?.id ||
          (waData as any).message?.id ||
          (waData as any).messageId ||
          (waData as any).key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const phoneToSave = phone || (isGroup ? toDigits(jid) : "");

    const created = await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        phone: phoneToSave,
        ownerId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        rawPayload: JSON.stringify(waData ?? null),
      },
      create: {
        phone: phoneToSave,
        ownerId,
        lineId,
        direction: "out",
        body: body || "",
        msgType,
        waMessageId,
        rawPayload: JSON.stringify(waData ?? null),
      },
    });

    return NextResponse.json(
      {
        message: {
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
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[agent-portal/messages POST] Error interno", err);
    return NextResponse.json({ error: err?.message || "Error interno" }, { status: 500 });
  }
}
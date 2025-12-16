import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

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

  if (!Array.isArray(lineIds) || lineIds.length === 0) return null;
  if (lineIdParam && lineIds.includes(lineIdParam)) return lineIdParam;
  return lineIds[0];
}

/**
 * ✅ FIX: respeta JIDs @lid y NO los convierte a @c.us
 */
function buildJidFromChatId(chatIdRaw: string) {
  const chatId = decodeURIComponent(chatIdRaw || "").trim();

  if (!chatId) return { jid: "", phone: null as string | null, isGroup: false };

  // ✅ si ya viene como JID (incluye @lid), lo respetamos
  if (chatId.includes("@")) {
    const lower = chatId.toLowerCase();

    if (lower.endsWith("@g.us")) return { jid: chatId, phone: null as string | null, isGroup: true };

    if (lower.endsWith("@c.us")) {
      const phone = toDigits(chatId.split("@")[0]);
      return { jid: chatId, phone: phone || null, isGroup: false };
    }

    // ✅ CLAVE: NO convertir @lid a @c.us
    if (lower.endsWith("@lid")) {
      return { jid: chatId, phone: null as string | null, isGroup: false };
    }

    // Otros sufijos raros: igual lo dejamos tal cual
    const phone = toDigits(chatId.split("@")[0]);
    return { jid: chatId, phone: phone || null, isGroup: false };
  }

  // si viene solo número
  const phone = toDigits(chatId);
  return { jid: phone ? `${phone}@c.us` : "", phone: phone || null, isGroup: false };
}

/**
 * ✅ Lee el body UNA SOLA VEZ y parsea JSON desde el texto.
 * Evita: "Body has already been read".
 */
async function fetchWaOnce(url: string, init?: RequestInit) {
  const res = await fetch(url, { cache: "no-store", ...(init || {}) } as any);
  const raw = await res.text().catch(() => "");
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    json = null;
  }
  return { res, raw, json };
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

    const limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get("limit") || "50", 10)));
    const includeMedia = (url.searchParams.get("includeMedia") ?? "1").trim() || "1";

    if (!token) return NextResponse.json({ error: "Falta token" }, { status: 400 });

    const { portal, error } = await getPortalFromToken(token);
    if (error || !portal) return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);
    if (!lineId) return NextResponse.json({ messages: [] }, { status: 200 });

    const { jid, phone, isGroup } = buildJidFromChatId(chatId);
    if (!jid) return NextResponse.json({ messages: [] }, { status: 200 });

    // ✅ CANONICAL WA ENDPOINT (evita alias y asegura chatId por query)
    const qs = new URLSearchParams({
      chatId: jid,
      limit: String(limit),
      includeMedia, // "1" por default
      mediaMax: "20",
    }).toString();

    const waEndpoint = `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/messages?${qs}`;

    // 1) WA-SERVER
    try {
      let first = await fetchWaOnce(waEndpoint);

      // Session not found -> conecto y retry 1 vez
      if (!first.res.ok && first.res.status === 404 && first.raw.includes("Session not found") && ownerId) {
        await ensureConnected(lineId, ownerId);
        first = await fetchWaOnce(waEndpoint);
      }

      if (first.res.ok) {
        const waMessages = first.json?.messages || [];
        const waStatus = first.json?.status;

        // ✅ si WA responde pero no connected, NO caemos al fallback DB
        if (waStatus && waStatus !== "connected") {
          return NextResponse.json({ messages: [], status: waStatus }, { status: 200 });
        }

        if (Array.isArray(waMessages) && waMessages.length) {
          // ✅ mapeo robusto (WA-SERVER devuelve "ts", tu UI usa "timestamp")
          const mapped = waMessages.map((m: any) => {
            const ts =
              typeof m?.ts === "number"
                ? m.ts
                : m?.timestamp
                ? new Date(m.timestamp).getTime()
                : Date.now();

            return {
              id: m?.id,
              fromMe: !!m?.fromMe,
              body: m?.body || "",
              timestamp: new Date(ts).toISOString(),
              type: m?.type || "text",
              media: m?.media || null,
              senderName: undefined,
              senderNumber: phone || null,
              senderAvatar: null,
              status: m?.status || undefined,
            };
          });

          mapped.sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
          return NextResponse.json({ messages: mapped }, { status: 200 });
        }

        // ✅ si WA ok pero no hay mensajes, devolvemos vacío (sin DB)
        return NextResponse.json({ messages: [] }, { status: 200 });
      } else {
        console.error("[agent-portal/messages GET] WA-SERVER error", first.res.status, first.raw.slice(0, 300));
      }
    } catch (err) {
      console.error("[agent-portal/messages GET] Error llamando WA-SERVER", err);
    }

    // 2) Fallback DB (solo individual) — solo si WA-SERVER no respondió bien
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
    if (error || !portal) return NextResponse.json({ error: error || "Token inválido" }, { status: 401 });

    const ownerId: string = portal.owner_user_id;
    const lineId = pickLineId(portal, lineIdParam);
    if (!lineId) return NextResponse.json({ error: "Portal sin líneas asignadas" }, { status: 400 });

    const bodyJson = await req.json().catch(() => ({} as any));
    const text = String(bodyJson?.body || bodyJson?.text || "").trim();
    const media = bodyJson?.media;

    if (!text && !media) {
      return NextResponse.json({ error: "Se requiere body/text (texto) o media" }, { status: 400 });
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

    let first = await fetchWaOnce(waUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text, text, media, type: msgType }),
    });

    if (!first.res.ok && first.res.status === 404 && first.raw.includes("Session not found")) {
      await ensureConnected(lineId, ownerId);
      first = await fetchWaOnce(waUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: text, text, media, type: msgType }),
      });
    }

    if (!first.res.ok) {
      console.error("[agent-portal/messages POST] WA-SERVER error", first.res.status, first.raw.slice(0, 300));
      return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
    }

    const waData = first.json || null;

    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id || waData.message?.id || waData.messageId || waData.key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Guardado DB (si es grupo no forzamos phone)
    const phoneToSave = phone || (isGroup ? "" : "");

    await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        phone: phoneToSave,
        ownerId,
        lineId,
        direction: "out",
        body: text || "",
        msgType,
        rawPayload: JSON.stringify(waData ?? null),
      },
      create: {
        phone: phoneToSave,
        ownerId,
        lineId,
        direction: "out",
        body: text || "",
        msgType,
        waMessageId,
        rawPayload: JSON.stringify(waData ?? null),
      },
    });

    return NextResponse.json(
      {
        message: {
          id: waMessageId,
          fromMe: true,
          body: text || "",
          timestamp: new Date().toISOString(),
          status: "sent" as const,
          type: msgType,
          media: media ?? null,
          senderName: undefined,
          senderNumber: phoneToSave || null,
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
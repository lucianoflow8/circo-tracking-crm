// app/api/chats/[chatId]/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "";

async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

const toDigits = (value: string | null | undefined) => (value || "").replace(/\D/g, "");

function resolvePhoneAndJid(rawChatId: string) {
  const trimmed = (rawChatId || "").trim();
  const phone = toDigits(trimmed);

  let jid: string;
  if (trimmed.includes("@")) jid = trimmed;
  else jid = `${phone}@c.us`;

  return { phone, jid };
}

function pickExternalLineId(row: any) {
  return (row?.external_line_id as string) || (row?.id as string) || null;
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

/**
 * Devuelve una lineId (external_line_id) válida para el usuario.
 * - Si viene desiredLineId: valida que sea del user (por external_line_id o id)
 * - Si no viene: intenta con lastMsgLineId (si pertenece al user)
 * - Si no: usa la "primera conectada" del user
 */
async function resolveUserLineId(opts: {
  userId: string;
  desiredLineId?: string | null;
  lastMsgLineId?: string | null;
}) {
  const { userId, desiredLineId, lastMsgLineId } = opts;

  const { data: myLines, error } = await supabaseAdmin
    .from("wa_lines")
    .select("id, external_line_id, status, owner_id")
    .eq("owner_id", userId)
    .in("status", ["connected", "CONNECTED"]);

  if (error) {
    console.error("[MESSAGES] Error leyendo wa_lines:", error.message);
    return { ok: false as const, error: "Error leyendo wa_lines" };
  }

  const connected = (myLines || []).filter(Boolean);
  if (!connected.length) {
    return { ok: false as const, error: "No tenés líneas conectadas" };
  }

  // 1) si viene desired, validar
  if (desiredLineId) {
    const found = connected.find(
      (l: any) => l.external_line_id === desiredLineId || l.id === desiredLineId
    );
    if (!found) return { ok: false as const, error: "Esa línea no pertenece al usuario" };

    const ext = pickExternalLineId(found);
    return { ok: true as const, lineId: ext! };
  }

  // 2) si no viene desired, probar lastMsgLineId (pero validarlo)
  if (lastMsgLineId) {
    const found = connected.find(
      (l: any) => l.external_line_id === lastMsgLineId || l.id === lastMsgLineId
    );
    if (found) {
      const ext = pickExternalLineId(found);
      return { ok: true as const, lineId: ext! };
    }
  }

  // 3) fallback: primera conectada
  const ext = pickExternalLineId(connected[0]);
  return { ok: true as const, lineId: ext! };
}

// ========= GET: WA-SERVER + DB =========
export async function GET(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    if (!WA_SERVER_URL) {
      return NextResponse.json({ error: "WA_SERVER_URL no configurado" }, { status: 500 });
    }

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

    const { chatId } = await unwrapParams(context.params);
    const { phone, jid } = resolvePhoneAndJid(chatId);

    if (!phone) return NextResponse.json({ messages: [] }, { status: 200 });

    const url = new URL(req.url);
    const desiredLineId = url.searchParams.get("lineId")?.trim() || null;

    // last line usada para ese phone
    let lastMsgLineId: string | null = null;
    try {
      const lastMsg = await prisma.crmMessage.findFirst({
        where: { phone, ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      lastMsgLineId = (lastMsg?.lineId as any) || null;
    } catch {}

    const resolved = await resolveUserLineId({ userId, desiredLineId, lastMsgLineId });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 });

    const lineId = resolved.lineId;

    const [waMessagesRaw, dbRows] = await Promise.all([
      (async () => {
        try {
          let waRes = await fetch(
            `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
            { cache: "no-store" }
          );

          // Session not found => autoconnect y retry 1 vez
          if (!waRes.ok) {
            const text = await waRes.text().catch(() => "");
            if (waRes.status === 404 && text.includes("Session not found")) {
              await ensureConnected(lineId, userId);
              waRes = await fetch(
                `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`,
                { cache: "no-store" }
              );
            }
          }

          if (!waRes.ok) {
            const text = await waRes.text();
            console.error("[MESSAGES GET] WA-SERVER error:", waRes.status, text.slice(0, 200));
            return [] as any[];
          }

          const waData = await waRes.json();
          const arr = (waData?.messages ?? []) as any[];
          return Array.isArray(arr) ? arr : [];
        } catch (err) {
          console.error("[MESSAGES GET] Error llamando WA-SERVER", err);
          return [] as any[];
        }
      })(),
      (async () => {
        try {
          return await prisma.crmMessage.findMany({
            where: { phone, ownerId: userId },
            orderBy: { createdAt: "asc" },
          });
        } catch (err) {
          console.error("[MESSAGES GET] Error leyendo CrmMessage", err);
          return [];
        }
      })(),
    ]);

    const dbMessages = dbRows.map((row) => ({
      id: row.waMessageId || row.id,
      fromMe: row.direction === "out",
      body: row.body || "",
      timestamp: row.createdAt.toISOString(),
      status: row.direction === "out" ? ("sent" as const) : undefined,
      type: (row.msgType as any) || "text",
      media: null,
      senderName: undefined,
      senderNumber: row.phone,
      senderAvatar: null,
    }));

    if (!waMessagesRaw.length && !dbMessages.length) {
      return NextResponse.json({ messages: [] }, { status: 200 });
    }

    const byId = new Map<string, any>();

    for (const m of dbMessages) {
      if (!m.id) continue;
      byId.set(String(m.id), { ...m });
    }

    for (const wm of waMessagesRaw) {
      const rawId = wm?.id || wm?.waMessageId || wm?.key?.id;
      if (!rawId) continue;

      const id = String(rawId);
      const prev = byId.get(id) || {};

      const tsIso =
        typeof wm.timestamp === "string"
          ? wm.timestamp
          : wm.timestamp
          ? new Date(wm.timestamp).toISOString()
          : prev.timestamp || new Date().toISOString();

      byId.set(id, { ...prev, ...wm, id, timestamp: tsIso });
    }

    const merged = Array.from(byId.values()).sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    return NextResponse.json({ messages: merged }, { status: 200 });
  } catch (err) {
    console.error("[MESSAGES GET] Error interno:", err);
    return NextResponse.json({ error: "Error interno al obtener mensajes" }, { status: 500 });
  }
}

// ========= POST: enviar + guardar =========
export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    if (!WA_SERVER_URL) {
      return NextResponse.json({ error: "WA_SERVER_URL no configurado" }, { status: 500 });
    }

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

    const { chatId } = await unwrapParams(context.params);

    const bodyJson = await req.json().catch(() => null);
    const rawBody = (bodyJson?.body as string | undefined) ?? "";
    const media = bodyJson?.media as
      | { mimetype: string; fileName?: string | null; dataUrl: string }
      | undefined;

    const body = rawBody.trim();
    if (!body && !media) {
      return NextResponse.json({ error: "Se requiere body (texto) o media" }, { status: 400 });
    }

    const { phone, jid } = resolvePhoneAndJid(chatId);
    if (!phone) return NextResponse.json({ error: "chatId inválido" }, { status: 400 });

    const url = new URL(req.url);
    const desiredLineId = url.searchParams.get("lineId")?.trim() || null;

    // last line usada para ese phone
    let lastMsgLineId: string | null = null;
    try {
      const lastMsg = await prisma.crmMessage.findFirst({
        where: { phone, ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      lastMsgLineId = (lastMsg?.lineId as any) || null;
    } catch {}

    const resolved = await resolveUserLineId({ userId, desiredLineId, lastMsgLineId });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 });

    const lineId = resolved.lineId;

    let msgType: string = "text";
    if (media) {
      const mt = media.mimetype || "";
      if (mt.startsWith("image/")) msgType = "image";
      else if (mt.startsWith("audio/")) msgType = "audio";
      else if (mt === "application/pdf" || mt.startsWith("application/")) msgType = "document";
      else msgType = "media";
    }

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
        await ensureConnected(lineId, userId);
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
      console.error("[MESSAGES POST] WA-SERVER error:", waRes.status, text.slice(0, 200));
      return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
    }

    let waData: any = null;
    try {
      waData = await waRes.json();
    } catch {}

    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id || waData.message?.id || waData.messageId || waData.key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const created = await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        phone,
        ownerId: userId,
        lineId,
        direction: "out",
        body,
        msgType,
        rawPayload: JSON.stringify(waData ?? null),
      },
      create: {
        phone,
        ownerId: userId,
        lineId,
        direction: "out",
        body,
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
    console.error("[MESSAGES POST] Error interno:", err);
    return NextResponse.json({ error: err?.message || "Error interno al enviar mensaje" }, { status: 500 });
  }
}


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
  if (!trimmed) return { phone: "", jid: "" };

  if (trimmed.includes("@")) {
    const phone = trimmed.endsWith("@c.us") ? toDigits(trimmed.split("@")[0]) : "";
    return { phone, jid: trimmed };
  }

  const phone = toDigits(trimmed);
  const jid = phone ? `${phone}@c.us` : "";
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
  if (!connected.length) return { ok: false as const, error: "No tenés líneas conectadas" };

  if (desiredLineId) {
    const found = connected.find((l: any) => l.external_line_id === desiredLineId || l.id === desiredLineId);
    if (!found) return { ok: false as const, error: "Esa línea no pertenece al usuario" };
    return { ok: true as const, lineId: pickExternalLineId(found)! };
  }

  if (lastMsgLineId) {
    const found = connected.find((l: any) => l.external_line_id === lastMsgLineId || l.id === lastMsgLineId);
    if (found) return { ok: true as const, lineId: pickExternalLineId(found)! };
  }

  return { ok: true as const, lineId: pickExternalLineId(connected[0])! };
}

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

// ========= GET =========
export async function GET(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    if (!WA_SERVER_URL) return NextResponse.json({ error: "WA_SERVER_URL no configurado" }, { status: 500 });

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

    const { chatId } = await unwrapParams(context.params);
    const { phone, jid } = resolvePhoneAndJid(chatId);
    if (!jid) return NextResponse.json({ messages: [] }, { status: 200 });

    const url = new URL(req.url);
    const desiredLineId = url.searchParams.get("lineId")?.trim() || null;
    const limit = url.searchParams.get("limit")?.trim() || null;
    const includeMedia = url.searchParams.get("includeMedia")?.trim() || null;

    let lastMsgLineId: string | null = null;
    if (phone) {
      try {
        const lastMsg = await prisma.crmMessage.findFirst({
          where: { phone, ownerId: userId },
          orderBy: { createdAt: "desc" },
        });
        lastMsgLineId = (lastMsg?.lineId as any) || null;
      } catch {}
    }

    const resolved = await resolveUserLineId({ userId, desiredLineId, lastMsgLineId });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 });

    const lineId = resolved.lineId;

    const waUrl =
      `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages?` +
      new URLSearchParams({
        ...(limit ? { limit } : {}),
        ...(includeMedia ? { includeMedia } : {}),
      }).toString();

    const [waMessagesRaw, dbRows] = await Promise.all([
      (async () => {
        try {
          let first = await fetchWaOnce(waUrl);

          if (!first.res.ok && first.res.status === 404 && first.raw.includes("Session not found")) {
            await ensureConnected(lineId, userId);
            first = await fetchWaOnce(waUrl);
          }

          if (!first.res.ok) {
            console.error("[MESSAGES GET] WA-SERVER error:", first.res.status, first.raw.slice(0, 200));
            return [] as any[];
          }

          const arr = (first.json?.messages ?? []) as any[];
          return Array.isArray(arr) ? arr : [];
        } catch (err) {
          console.error("[MESSAGES GET] Error llamando WA-SERVER", err);
          return [] as any[];
        }
      })(),
      (async () => {
        if (!phone) return [];
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

    const byId = new Map<string, any>();

    for (const m of dbMessages) if (m.id) byId.set(String(m.id), { ...m });

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

// ========= POST =========
export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    if (!WA_SERVER_URL) return NextResponse.json({ error: "WA_SERVER_URL no configurado" }, { status: 500 });

    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

    const { chatId } = await unwrapParams(context.params);

    const bodyJson = await req.json().catch(() => ({} as any));
    const body = String(bodyJson?.body || bodyJson?.text || "").trim();
    const media = bodyJson?.media as
      | { mimetype: string; fileName?: string | null; dataUrl: string }
      | undefined;

    if (!body && !media) return NextResponse.json({ error: "Se requiere body/text o media" }, { status: 400 });

    const { phone, jid } = resolvePhoneAndJid(chatId);
    if (!jid) return NextResponse.json({ error: "chatId inválido" }, { status: 400 });

    const url = new URL(req.url);
    const desiredLineId = url.searchParams.get("lineId")?.trim() || null;

    let lastMsgLineId: string | null = null;
    if (phone) {
      try {
        const lastMsg = await prisma.crmMessage.findFirst({
          where: { phone, ownerId: userId },
          orderBy: { createdAt: "desc" },
        });
        lastMsgLineId = (lastMsg?.lineId as any) || null;
      } catch {}
    }

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

    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(jid)}/messages`;

    let first = await fetchWaOnce(waUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body, text: body, media, type: msgType }),
    });

    if (!first.res.ok && first.res.status === 404 && first.raw.includes("Session not found")) {
      await ensureConnected(lineId, userId);
      first = await fetchWaOnce(waUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, text: body, media, type: msgType }),
      });
    }

    if (!first.res.ok) {
      console.error("[MESSAGES POST] WA-SERVER error:", first.res.status, first.raw.slice(0, 200));
      return NextResponse.json({ error: "Error al enviar mensaje a WA-SERVER" }, { status: 500 });
    }

    const waData = first.json || null;

    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id || waData.message?.id || waData.messageId || waData.key?.id)) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    let created: any = null;
    if (phone) {
      created = await prisma.crmMessage.upsert({
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
    }

    return NextResponse.json(
      {
        message: {
          id: created?.waMessageId || waMessageId,
          fromMe: true,
          body: created?.body || body || "",
          timestamp: (created?.createdAt ? created.createdAt.toISOString() : new Date().toISOString()),
          status: "sent" as const,
          type: (created?.msgType as any) || msgType || "text",
          media: media ?? null,
          senderName: undefined,
          senderNumber: phone || null,
          senderAvatar: null,
        },
      },
      { status: 200 }
    );
  } catch (err: any) {
    console.error("[MESSAGES POST] Error interno:", err);
    return NextResponse.json({ error: err?.message || "Error interno" }, { status: 500 });
  }
}
// app/api/chats/[chatId]/messages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "";

// Helper params (soporta objeto o Promise)
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

const toDigits = (value: string | null | undefined) =>
  (value || "").replace(/\D/g, "");

/**
 * Dado un chatId como viene en la URL, arma:
 *  - phoneDigits: solo números para DB (54911...)
 *  - jid: JID real para WhatsApp (54911...@c.us o lo que venga)
 */
function resolvePhoneAndJid(rawChatId: string) {
  const trimmed = (rawChatId || "").trim();

  const phone = toDigits(trimmed);

  let jid: string;
  if (trimmed.includes("@")) {
    jid = trimmed;
  } else {
    jid = `${phone}@c.us`;
  }

  return { phone, jid };
}

async function ensureLineOwnedByUser(userId: string, lineId: string) {
  const { data, error } = await supabaseAdmin
    .from("wa_lines")
    .select("id, external_line_id, owner_id, status")
    .eq("owner_id", userId)
    .or(`external_line_id.eq.${lineId},id.eq.${lineId}`)
    .maybeSingle();

  if (error) return null;
  if (!data) return null;

  // usamos SIEMPRE external_line_id si existe
  return (data as any).external_line_id || (data as any).id || null;
}

async function pickAnyConnectedLineForUser(userId: string) {
  const { data, error } = await supabaseAdmin
    .from("wa_lines")
    .select("id, external_line_id, status, last_assigned_at")
    .eq("owner_id", userId)
    .in("status", ["connected", "CONNECTED"]);

  if (error) return null;
  const lines = (data || []).filter(Boolean);
  if (!lines.length) return null;

  // elegimos la menos recientemente asignada (balance)
  const sorted = [...lines].sort((a: any, b: any) => {
    const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0;
    const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0;
    return aTime - bTime;
  });

  const chosen: any = sorted[0];
  const external = chosen.external_line_id || chosen.id || null;

  // marcamos last_assigned_at (no es obligatorio, pero ayuda)
  try {
    await supabaseAdmin
      .from("wa_lines")
      .update({ last_assigned_at: new Date().toISOString() })
      .eq("id", chosen.id);
  } catch {}

  return external;
}

// ========= GET: combina mensajes de WA-SERVER + CrmMessage =========
export async function GET(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  const { chatId } = await unwrapParams(context.params);
  const { phone, jid } = resolvePhoneAndJid(chatId);

  if (!phone) {
    return NextResponse.json({ messages: [] }, { status: 200 });
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  if (!WA_SERVER_URL) {
    return NextResponse.json(
      { error: "WA_SERVER_URL no configurado" },
      { status: 500 }
    );
  }

  // 1) lineId (override) viene del front si el chat venía de /api/chats
  const url = new URL(req.url);
  const lineIdFromQuery = url.searchParams.get("lineId")?.trim() || null;

  // 2) Resolver línea a usar:
  // - si vino lineId => validar que es del user
  // - si no vino => usar última lineId usada en CrmMessage (si existe)
  // - si no hay => elegir cualquier conectada del user
  let lineId: string | null = null;

  if (lineIdFromQuery) {
    lineId = await ensureLineOwnedByUser(userId, lineIdFromQuery);
    if (!lineId) {
      return NextResponse.json(
        { error: "Esa línea no pertenece al usuario" },
        { status: 403 }
      );
    }
  } else {
    try {
      const lastMsg = await prisma.crmMessage.findFirst({
        where: { phone, ownerId: userId },
        orderBy: { createdAt: "desc" },
      });
      if (lastMsg?.lineId) {
        // validar ownership por seguridad
        const ok = await ensureLineOwnedByUser(userId, lastMsg.lineId);
        if (ok) lineId = ok;
      }
    } catch (err) {
      console.error("[API/CHAT MESSAGES GET] Error buscando lastMsg:", err);
    }

    if (!lineId) {
      lineId = await pickAnyConnectedLineForUser(userId);
    }
  }

  if (!lineId) {
    return NextResponse.json(
      { messages: [], info: "No tenés líneas conectadas para leer mensajes." },
      { status: 200 }
    );
  }

  // ==== Traemos en paralelo WA-SERVER + Prisma ====
  const [waMessagesRaw, dbRows] = await Promise.all([
    (async () => {
      try {
        const waRes = await fetch(
          `${WA_SERVER_URL}/lines/${encodeURIComponent(
            lineId
          )}/chats/${encodeURIComponent(jid)}/messages`,
          { cache: "no-store" }
        );

        if (!waRes.ok) {
          const text = await waRes.text();
          console.error(
            "[API/CHAT MESSAGES GET] WA-SERVER messages error:",
            waRes.status,
            text.slice(0, 300)
          );
          return [] as any[];
        }

        const waData = await waRes.json();
        const arr = (waData?.messages ?? []) as any[];
        return Array.isArray(arr) ? arr : [];
      } catch (err) {
        console.error("[API/CHAT MESSAGES GET] Error WA-SERVER", err);
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
        console.error("[API/CHAT MESSAGES GET] Error leyendo CrmMessage", err);
        return [];
      }
    })(),
  ]);

  const dbMessages = dbRows.map((row) => {
    const id = row.waMessageId || row.id;
    return {
      id,
      fromMe: row.direction === "out",
      body: row.body || "",
      timestamp: row.createdAt.toISOString(),
      status: row.direction === "out" ? ("sent" as const) : undefined,
      type: (row.msgType as any) || "text",
      media: null,
      senderName: undefined,
      senderNumber: row.phone,
      senderAvatar: null,
    };
  });

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

    byId.set(id, {
      ...prev,
      ...wm,
      id,
      timestamp: tsIso,
    });
  }

  const merged = Array.from(byId.values()).sort(
    (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return NextResponse.json({ messages: merged }, { status: 200 });
}

// ========= POST: enviar mensaje Y guardarlo en CrmMessage =========
export async function POST(
  req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);
    const bodyJson = await req.json().catch(() => null);
    const rawBody = (bodyJson?.body as string | undefined) ?? "";
    const media = bodyJson?.media as
      | { mimetype: string; fileName?: string | null; dataUrl: string }
      | undefined;

    const body = rawBody.trim();

    if (!body && !media) {
      return NextResponse.json(
        { error: "Se requiere body (texto) o media" },
        { status: 400 }
      );
    }

    const { phone, jid } = resolvePhoneAndJid(chatId);

    if (!phone) {
      return NextResponse.json({ error: "chatId inválido" }, { status: 400 });
    }

    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    if (!WA_SERVER_URL) {
      return NextResponse.json(
        { error: "WA_SERVER_URL no configurado" },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const lineIdFromQuery = url.searchParams.get("lineId")?.trim() || null;

    let lineId: string | null = null;

    if (lineIdFromQuery) {
      lineId = await ensureLineOwnedByUser(userId, lineIdFromQuery);
      if (!lineId) {
        return NextResponse.json(
          { error: "Esa línea no pertenece al usuario" },
          { status: 403 }
        );
      }
    } else {
      // fallback: última línea usada con ese phone (si existe y es tuya)
      try {
        const lastMsg = await prisma.crmMessage.findFirst({
          where: { phone, ownerId: userId },
          orderBy: { createdAt: "desc" },
        });

        if (lastMsg?.lineId) {
          const ok = await ensureLineOwnedByUser(userId, lastMsg.lineId);
          if (ok) lineId = ok;
        }
      } catch {}

      if (!lineId) {
        lineId = await pickAnyConnectedLineForUser(userId);
      }
    }

    if (!lineId) {
      return NextResponse.json(
        { error: "No tenés líneas conectadas para enviar mensajes." },
        { status: 400 }
      );
    }

    let msgType: string = "text";
    if (media) {
      const mt = media.mimetype || "";
      if (mt.startsWith("image/")) msgType = "image";
      else if (mt.startsWith("audio/")) msgType = "audio";
      else if (mt === "application/pdf" || mt.startsWith("application/"))
        msgType = "document";
      else msgType = "media";
    } else {
      msgType = "text";
    }

    const waRes = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(
        lineId
      )}/chats/${encodeURIComponent(jid)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, media, type: msgType }),
      }
    );

    if (!waRes.ok) {
      const text = await waRes.text().catch(() => "");
      console.error("WA-SERVER messages POST error:", waRes.status, text.slice(0, 300));
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

    const waMessageId: string =
      (waData &&
        (waData.message?.id?.id ||
          waData.message?.id ||
          waData.messageId ||
          waData.key?.id)) ||
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
    console.error("Error /api/chats/[chatId]/messages POST", err);
    return NextResponse.json(
      { error: err?.message || "Error interno al enviar mensaje" },
      { status: 500 }
    );
  }
}

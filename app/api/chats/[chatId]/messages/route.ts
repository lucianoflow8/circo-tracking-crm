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

// ========= GET: combina mensajes de WA-SERVER + CrmMessage =========
export async function GET(
  _req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  const { chatId } = await unwrapParams(context.params);
  const phone = toDigits(chatId);

  if (!phone) {
    return NextResponse.json({ messages: [] }, { status: 200 });
  }

  const userId = await getCurrentUserId();
  if (!userId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  // ==== Resolvem​os la línea a usar ====
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

  const jid = `${phone}@c.us`;

  // ==== Traemos en paralelo WA-SERVER + Prisma ====
  const [waMessagesRaw, dbRows] = await Promise.all([
    (async () => {
      try {
        const waRes = await fetch(
          `${WA_SERVER_URL}/lines/${encodeURIComponent(
            lineId
          )}/chats/${encodeURIComponent(jid)}/messages`
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
        console.error(
          "[API/CHAT MESSAGES GET] Error llamando a WA-SERVER",
          err
        );
        return [] as any[];
      }
    })(),
    (async () => {
      try {
        return await prisma.crmMessage.findMany({
          where: {
            phone,
            ownerId: userId,
          },
          orderBy: { createdAt: "asc" },
        });
      } catch (err) {
        console.error(
          "[API/CHAT MESSAGES GET] Error leyendo CrmMessage (fallback)",
          err
        );
        return [];
      }
    })(),
  ]);

  // Normalizamos los mensajes de Prisma al mismo formato que usamos en el front
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

  // Si no hay nada de ninguno, devolvemos vacío
  if (!waMessagesRaw.length && !dbMessages.length) {
    return NextResponse.json({ messages: [] }, { status: 200 });
  }

  // ==== Merge WA + DB por id, dando prioridad a WA para status/type/timestamp ====
  const byId = new Map<string, any>();

  // Primero metemos lo que viene de DB
  for (const m of dbMessages) {
    if (!m.id) continue;
    byId.set(String(m.id), { ...m });
  }

  // Ahora pisamos/completamos con lo de WA-SERVER
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

  // A array + orden cronológico ascendente
  const merged = Array.from(byId.values()).sort(
    (a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
  );

  return NextResponse.json({ messages: merged }, { status: 200 });
}
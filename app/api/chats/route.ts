// app/api/chats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || "";

if (!WA_SERVER_URL) {
  console.warn("[API/CHATS] Falta WA_SERVER_URL en env");
}

function pickExternalLineId(row: any, fallback: string) {
  return (row?.external_line_id as string) || (row?.id as string) || fallback;
}

// GET /api/chats
// Opcional: /api/chats?lineId=xxxx  (solo si esa línea pertenece al user)
export async function GET(req: NextRequest) {
  try {
    if (!WA_SERVER_URL) {
      return NextResponse.json(
        { error: "WA_SERVER_URL no configurado" },
        { status: 500 }
      );
    }

    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ error: "No autenticado" }, { status: 401 });
    }

    const url = new URL(req.url);
    const lineIdFromQuery = url.searchParams.get("lineId")?.trim() || null;

    // 1) Traer líneas CONECTADAS del usuario
    const { data: myLines, error: linesError } = await supabaseAdmin
      .from("wa_lines")
      .select("id, external_line_id, status, owner_id, last_assigned_at")
      .eq("owner_id", userId)
      .in("status", ["connected", "CONNECTED"]);

    if (linesError) {
      console.error("[API/CHATS] Error leyendo wa_lines:", linesError.message);
      return NextResponse.json(
        { error: "Error leyendo líneas del usuario" },
        { status: 500 }
      );
    }

    const connected = (myLines || []).filter(Boolean);
    if (!connected.length) {
      return NextResponse.json(
        { chats: [], info: "No tenés líneas de WhatsApp conectadas." },
        { status: 200 }
      );
    }

    // 2) Si viene lineId en query, validar que es del usuario
    let lineIdsToFetch: string[] = [];
    if (lineIdFromQuery) {
      const found = connected.find(
        (l: any) =>
          l.external_line_id === lineIdFromQuery || l.id === lineIdFromQuery
      );

      if (!found) {
        return NextResponse.json(
          { error: "Esa línea no pertenece al usuario" },
          { status: 403 }
        );
      }

      lineIdsToFetch = [pickExternalLineId(found, lineIdFromQuery)];
    } else {
      // 3) Si NO viene lineId => traemos chats de TODAS sus líneas conectadas
      lineIdsToFetch = connected.map((l: any) =>
        pickExternalLineId(l, String(l?.id || ""))
      );
    }

    // 4) Fetch chats por línea (parallel)
    const results = await Promise.all(
      lineIdsToFetch.map(async (lineId) => {
        const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(
          lineId
        )}/chats`;

        try {
          const res = await fetch(waUrl, { cache: "no-store" });
          const text = await res.text();

          let data: any = {};
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text };
          }

          // Si la sesión no existe: no revienta, solo devuelve vacío para esa línea
          if (!res.ok) {
            if (res.status === 404 && data?.error === "Session not found") {
              return { lineId, chats: [] as any[] };
            }
            console.error("[API/CHATS] WA-SERVER error:", lineId, res.status, data);
            return { lineId, chats: [] as any[] };
          }

          const waChats: any[] = Array.isArray(data) ? data : data.chats || [];
          return { lineId, chats: waChats };
        } catch (err) {
          console.error("[API/CHATS] Error llamando WA-SERVER para line:", lineId, err);
          return { lineId, chats: [] as any[] };
        }
      })
    );

    // 5) Normalizar + merge por chatId (si el mismo chat aparece en 2 líneas, queda el más reciente)
    const byChatId = new Map<string, any>();

    for (const pack of results) {
      const lineId = pack.lineId;

      for (const c of pack.chats || []) {
        const rawId: string =
          c.id?._serialized || c.waChatId || c.id || String(c.chatId || "");

        if (!rawId) continue;

        const isGroup =
          !!c.isGroup ||
          rawId.endsWith("@g.us") ||
          (c.id && String(c.id).includes("@g.us"));

        let phone: string | null = null;
        if (!isGroup) {
          const match =
            rawId.match(/^(\d+)(@c\.us)?$/) ||
            rawId.match(/^(\d+)(-|@)/) ||
            rawId.match(/(\d+)/);
          phone = match ? match[1] : null;
        }

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
              (c.contact.name || c.contact.pushname || c.contact.shortName)) ||
            phone ||
            "Sin nombre"
          );
        })();

        const normalized = {
          id: rawId,
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
          profilePicUrl: c.profilePicUrl || c.avatarUrl || c.photoUrl || null,

          // 👇 CLAVE: a qué línea pertenece este chat
          lineId,
        };

        const prev = byChatId.get(rawId);

        // comparar “recencia”
        const prevTs =
          prev?.lastTimestampMs ??
          (prev?.lastMessageAt ? new Date(prev.lastMessageAt).getTime() : 0);

        const curTs =
          normalized.lastTimestampMs ??
          (normalized.lastMessageAt
            ? new Date(normalized.lastMessageAt).getTime()
            : 0);

        if (!prev || curTs >= prevTs) {
          byChatId.set(rawId, normalized);
        }
      }
    }

    // ordenar: más reciente arriba
    const chats = Array.from(byChatId.values()).sort((a, b) => {
      const aTs =
        a.lastTimestampMs ??
        (a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0);
      const bTs =
        b.lastTimestampMs ??
        (b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0);
      return bTs - aTs;
    });

    return NextResponse.json({ chats }, { status: 200 });
  } catch (err) {
    console.error("[API/CHATS] Error interno:", err);
    return NextResponse.json(
      { error: "Error interno al obtener chats" },
      { status: 500 }
    );
  }
}

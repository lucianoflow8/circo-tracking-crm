import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

// ✅ lee body una sola vez (evita problemas de stream)
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

// ✅ si no existe sesión, intentamos crearla/conectarla y reintentar 1 vez
async function ensureConnected(lineId: string, ownerId: string) {
  try {
    await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId }),
    }).catch(() => null);
  } catch {}
}

const toDigits = (value: string | null | undefined) => (value || "").replace(/\D/g, "");

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Falta token de portal" },
        { status: 400 }
      );
    }

    const { data: portal, error } = await supabaseAdmin
      .from("agent_portals")
      .select("id, owner_user_id, mode, line_ids, enabled")
      .eq("token", token)
      .maybeSingle();

    if (error) {
      console.error("[agent-portal/chats] Error select portal:", error);
      return NextResponse.json(
        { ok: false, error: "No se pudo leer el portal" },
        { status: 500 }
      );
    }

    if (!portal || portal.enabled === false) {
      return NextResponse.json(
        { ok: true, lineId: null, chats: [], info: "Portal inexistente o deshabilitado" },
        { status: 200 }
      );
    }

    const ownerId = String((portal as any).owner_user_id || "");
    const lineIds: string[] = (portal as any).line_ids || [];

    if (!Array.isArray(lineIds) || lineIds.length === 0) {
      return NextResponse.json(
        { ok: true, lineId: null, chats: [], info: "Este portal aún no tiene líneas asignadas" },
        { status: 200 }
      );
    }

    const lineIdParam = url.searchParams.get("lineId");
    const effectiveLineId =
      lineIdParam && lineIds.includes(lineIdParam) ? lineIdParam : lineIds[0];

    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(effectiveLineId)}/chats`;

    // 1) llamo WA-SERVER
    let first = await fetchWaOnce(waUrl);

    // 2) si Session not found -> conecto y reintento 1 vez
    const firstErr = first.json?.error || "";
    if (
      !first.res.ok &&
      first.res.status === 404 &&
      (first.raw.includes("Session not found") || firstErr === "Session not found") &&
      ownerId
    ) {
      await ensureConnected(effectiveLineId, ownerId);
      first = await fetchWaOnce(waUrl);
    }

    if (!first.res.ok) {
      console.error("[agent-portal/chats] Error WA-SERVER:", first.res.status, first.raw.slice(0, 300));

      // si sigue sin sesión, devolvemos vacío pero OK
      if (
        first.res.status === 404 &&
        (first.raw.includes("Session not found") || (first.json?.error || "") === "Session not found")
      ) {
        return NextResponse.json(
          {
            ok: true,
            lineId: effectiveLineId,
            chats: [],
            info: "La sesión de WhatsApp para esta línea no está conectada (Session not found).",
          },
          { status: 200 }
        );
      }

      return NextResponse.json(
        {
          ok: false,
          error: "No se pudieron cargar los chats",
          waStatus: first.res.status,
          waBody: first.json ?? { raw: first.raw },
        },
        { status: 500 }
      );
    }

    const data = first.json ?? {};
    const waChats: any[] = Array.isArray(data) ? data : data.chats || [];
    // const waStatus = (Array.isArray(data) ? null : data.status) || null; // (opcional si lo querés)

    const chats = waChats.map((c) => {
      // ✅ id tal cual viene (puede ser @c.us / @g.us / @lid)
      const rawId: string =
        c.id?._serialized || c.waChatId || c.id || String(c.chatId || "");

      const isGroup =
        !!c.isGroup || rawId.endsWith("@g.us") || (c.id && String(c.id).includes("@g.us"));

      let phone: string | null = null;
      if (!isGroup) {
        if (rawId.includes("@")) {
          phone = toDigits(rawId.split("@")[0]);
        } else {
          const m = rawId.match(/(\d+)/);
          phone = m ? m[1] : null;
        }
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
          (c.contact && (c.contact.name || c.contact.pushname || c.contact.shortName)) ||
          phone ||
          "Sin nombre"
        );
      })();

      return {
        id: rawId,
        waChatId: rawId,
        lineId: effectiveLineId, // ✅ CLAVE
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
      };
    });

    return NextResponse.json({ ok: true, lineId: effectiveLineId, chats }, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats] Excepción:", e);
    return NextResponse.json(
      { ok: false, error: "Error interno al cargar chats" },
      { status: 500 }
    );
  }
}
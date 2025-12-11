// app/api/agent-portal/chats/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

if (!WA_SERVER_URL) {
  console.warn("[agent-portal/chats] Falta WA_SERVER_URL en env");
}

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

    // 1) Buscar portal por token en Supabase
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
        {
          ok: true,
          lineId: null,
          chats: [],
          info: "Portal inexistente o deshabilitado",
        },
        { status: 200 }
      );
    }

    const lineIds: string[] = (portal as any).line_ids || [];

    if (!Array.isArray(lineIds) || lineIds.length === 0) {
      return NextResponse.json(
        {
          ok: true,
          lineId: null,
          chats: [],
          info: "Este portal aún no tiene líneas asignadas",
        },
        { status: 200 }
      );
    }

    // 2) Elegir línea: ?lineId= (si está en el portal) o la primera
    const lineIdParam = url.searchParams.get("lineId");
    let effectiveLineId =
      lineIdParam && lineIds.includes(lineIdParam)
        ? lineIdParam
        : lineIds[0];

    // 3) Pedir chats al WA-SERVER
    const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(
      effectiveLineId
    )}/chats`;

    const res = await fetch(waUrl, { cache: "no-store" });
    const text = await res.text();

    let data: any = {};
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      console.error("[agent-portal/chats] Error WA-SERVER:", res.status, data);

      if (res.status === 404 && data?.error === "Session not found") {
        // Para el cajero devolvemos vacío pero sin romper
        return NextResponse.json(
          {
            ok: true,
            lineId: effectiveLineId,
            chats: [],
            info:
              "La sesión de WhatsApp para esta línea no está conectada (Session not found).",
          },
          { status: 200 }
        );
      }

      return NextResponse.json(
        {
          ok: false,
          error: "No se pudieron cargar los chats",
          waStatus: res.status,
          waBody: data,
        },
        { status: 500 }
      );
    }

    const waChats: any[] = Array.isArray(data) ? data : data.chats || [];

    const chats = waChats.map((c) => {
      const rawId: string =
        c.id?._serialized || c.waChatId || c.id || String(c.chatId || "");

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
            (c.contact.name ||
              c.contact.pushname ||
              c.contact.shortName)) ||
          phone ||
          "Sin nombre"
        );
      })();

      return {
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
        profilePicUrl:
          c.profilePicUrl || c.avatarUrl || c.photoUrl || null,
      };
    });

    return NextResponse.json(
      { ok: true, lineId: effectiveLineId, chats },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[agent-portal/chats] Excepción:", e);
    return NextResponse.json(
      { ok: false, error: "Error interno al cargar chats" },
      { status: 500 }
    );
  }
}
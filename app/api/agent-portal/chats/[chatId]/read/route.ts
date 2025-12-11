// app/api/agent-portal/chats/[chatId]/read/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || "";

if (!WA_SERVER_URL) {
  console.warn("[agent-portal/read] Falta WA_SERVER_URL en env");
}
if (!DEFAULT_LINE_ID) {
  console.warn("[agent-portal/read] WA_DEFAULT_LINE_ID está vacío (se usará sólo como fallback)");
}

// Supabase para leer agent_portals
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || "";

let supabase: ReturnType<typeof createClient> | null = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
} else {
  console.warn(
    "[agent-portal/read] No se pudo inicializar Supabase (faltan SUPABASE_URL o SERVICE_KEY)"
  );
}

// 👇 IMPORTANTE: en Next 16 los params vienen como Promise
type RouteContext = {
  params: Promise<{ chatId: string }>;
};

export async function POST(req: NextRequest, ctx: RouteContext) {
  try {
    const { chatId: rawChatId } = await ctx.params;
    const chatId = decodeURIComponent(rawChatId || "");

    if (!chatId) {
      return NextResponse.json(
        { error: "chatId requerido" },
        { status: 400 }
      );
    }

    // ===========================
    // 1) Detectar token del portal
    // ===========================
    const reqUrl = new URL(req.url);
    let token = reqUrl.searchParams.get("token");

    // Si el front no manda ?token=..., tratamos de leerlo del referer: https://.../portal/<token>
    if (!token) {
      const referer =
        req.headers.get("referer") || req.headers.get("referrer") || "";
      if (referer) {
        try {
          const refUrl = new URL(referer);
          const segments = refUrl.pathname.split("/").filter(Boolean);
          // /portal/<token>
          if (segments[0] === "portal" && segments[1]) {
            token = segments[1];
          }
        } catch {
          // ignore parse error
        }
      }
    }

    // ===========================
    // 2) Resolver lineId efectivo
    // ===========================
    let effectiveLineId: string | null = null;

    if (token && supabase) {
      const { data: portal, error } = await supabase
        .from("agent_portals")
        .select("id, token, enabled, line_ids")
        .eq("token", token)
        .maybeSingle();

      if (error) {
        console.error("[agent-portal/read] Error leyendo agent_portals:", error);
      } else if (portal && (portal as any).enabled !== false) {
        const lineIds: string[] = (portal as any).line_ids || [];
        if (Array.isArray(lineIds) && lineIds.length > 0) {
          effectiveLineId = lineIds[0]; // por ahora usamos la primera
        }
      }
    }

    // Fallback: usar WA_DEFAULT_LINE_ID si no pudimos resolver por token
    if (!effectiveLineId && DEFAULT_LINE_ID) {
      effectiveLineId = DEFAULT_LINE_ID;
    }

    if (!effectiveLineId) {
      return NextResponse.json(
        {
          error:
            "No se pudo determinar la línea de WhatsApp para este portal (ni token ni WA_DEFAULT_LINE_ID válidos).",
        },
        { status: 500 }
      );
    }

    console.log(
      "[agent-portal/chats/[chatId]/read] Marcando como leído → lineId=",
      effectiveLineId,
      "chatId=",
      chatId
    );

    const res = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(
        effectiveLineId
      )}/chats/${encodeURIComponent(chatId)}/read`,
      {
        method: "POST",
      }
    );

    const data = await res.json().catch(() => ({} as any));

    if (!res.ok) {
      console.error(
        "[agent-portal/chats/[chatId]/read] Error WA-SERVER:",
        res.status,
        data
      );
      return NextResponse.json(
        { error: data.error || "No se pudo marcar el chat como leído" },
        { status: 500 }
      );
    }

    // data debería ser { ok: true }
    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats/[chatId]/read] Excepción:", e);
    return NextResponse.json(
      { error: e?.message || "Error interno" },
      { status: 500 }
    );
  }
}
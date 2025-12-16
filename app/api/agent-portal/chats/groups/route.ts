import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

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

async function ensureConnected(lineId: string, ownerId: string) {
  try {
    await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId }),
    }).catch(() => null);
  } catch {}
}

function pickLineId(portal: any, lineIdParam: string | null) {
  const lineIds: string[] = (portal?.line_ids || []) as string[];
  if (!Array.isArray(lineIds) || lineIds.length === 0) return null;
  if (lineIdParam && lineIds.includes(lineIdParam)) return lineIdParam;
  return lineIds[0];
}

export async function POST(req: NextRequest) {
  // ✅ body
  const body = await req.json().catch(() => ({} as any));

  if (!body?.name) {
    return NextResponse.json({ error: "Falta el nombre del grupo" }, { status: 400 });
  }

  // ✅ token (multinivel)
  const url = new URL(req.url);
  const token = (url.searchParams.get("token") || "").trim();
  const lineIdParam = url.searchParams.get("lineId"); // opcional (si algún día querés elegir línea)

  if (!token) {
    return NextResponse.json({ error: "Falta token de portal" }, { status: 400 });
  }

  // ✅ buscar portal
  const { data: portal, error } = await supabaseAdmin
    .from("agent_portals")
    .select("id, owner_user_id, line_ids, enabled")
    .eq("token", token)
    .maybeSingle();

  if (error) {
    console.error("[agent-portal/chats/groups POST] Error select portal:", error);
    return NextResponse.json({ error: "No se pudo leer el portal" }, { status: 500 });
  }

  if (!portal || portal.enabled === false) {
    return NextResponse.json({ error: "Portal inexistente o deshabilitado" }, { status: 401 });
  }

  const ownerId = String((portal as any).owner_user_id || "");
  const effectiveLineId = pickLineId(portal, lineIdParam);

  if (!effectiveLineId) {
    return NextResponse.json(
      { error: "Este portal no tiene líneas asignadas" },
      { status: 400 }
    );
  }

  // ✅ llamar WA-SERVER a la línea correcta
  const waUrl = `${WA_SERVER_URL}/lines/${encodeURIComponent(effectiveLineId)}/groups`;

  try {
    let first = await fetchWaOnce(waUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), // name, participants, admins, avatar, etc.
    });

    // Session not found -> connect + retry 1 vez
    const errMsg = first.json?.error || "";
    if (
      !first.res.ok &&
      first.res.status === 404 &&
      (first.raw.includes("Session not found") || errMsg === "Session not found") &&
      ownerId
    ) {
      await ensureConnected(effectiveLineId, ownerId);
      first = await fetchWaOnce(waUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    }

    if (!first.res.ok) {
      console.error(
        "[agent-portal/chats/groups POST] Error WA-SERVER:",
        first.res.status,
        first.raw.slice(0, 500)
      );

      return NextResponse.json(
        { error: (first.json?.error as string) || "No se pudo crear el grupo" },
        { status: first.res.status || 500 }
      );
    }

    return NextResponse.json(first.json ?? {}, { status: 200 });
  } catch (e: any) {
    console.error("[agent-portal/chats/groups POST] Excepción:", e);
    return NextResponse.json(
      { error: e.message || "No se pudo crear el grupo" },
      { status: 500 }
    );
  }
}
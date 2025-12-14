// app/api/chats/[chatId]/read/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "";

function pickExternalLineId(row: any) {
  return (row?.external_line_id as string) || (row?.id as string) || null;
}

async function resolveUserLineId(userId: string, desiredLineId?: string | null) {
  const { data: myLines, error } = await supabaseAdmin
    .from("wa_lines")
    .select("id, external_line_id, status, owner_id")
    .eq("owner_id", userId)
    .in("status", ["connected", "CONNECTED"]);

  if (error) return { ok: false as const, error: "Error leyendo wa_lines" };

  const connected = (myLines || []).filter(Boolean);
  if (!connected.length) return { ok: false as const, error: "No tenés líneas conectadas" };

  if (desiredLineId) {
    const found = connected.find(
      (l: any) => l.external_line_id === desiredLineId || l.id === desiredLineId
    );
    if (!found) return { ok: false as const, error: "Esa línea no pertenece al usuario" };
    return { ok: true as const, lineId: pickExternalLineId(found)! };
  }

  return { ok: true as const, lineId: pickExternalLineId(connected[0])! };
}

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

    const params = await Promise.resolve(context.params);
    const chatId = params.chatId;

    const url = new URL(req.url);
    const desiredLineId = url.searchParams.get("lineId")?.trim() || null;

    const resolved = await resolveUserLineId(userId, desiredLineId);
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 403 });

    const lineId = resolved.lineId;

    // chatId puede venir como "54911...@c.us" o "@g.us" o solo número
    const normalizedChatId = chatId.includes("@") ? chatId : `${chatId.replace(/\D/g, "")}@c.us`;

    const waRes = await fetch(
      `${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/chats/${encodeURIComponent(normalizedChatId)}/read`,
      { method: "POST", cache: "no-store" }
    );

    const data = await waRes.json().catch(() => ({}));
    return NextResponse.json(data, { status: waRes.status });
  } catch (e) {
    console.error("[READ] Error interno:", e);
    return NextResponse.json({ error: "Error interno al marcar leído" }, { status: 500 });
  }
}

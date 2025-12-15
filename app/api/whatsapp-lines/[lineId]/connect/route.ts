import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: { lineId: string } }
) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const lineId = params.lineId; // id Prisma WhatsappLine (cuid)
    const WA_SERVER_URL = process.env.WA_SERVER_URL;
    if (!WA_SERVER_URL) {
      return NextResponse.json({ ok: false, error: "Falta WA_SERVER_URL" }, { status: 500 });
    }

    // 1) Validar que esa línea exista y sea del usuario (multi-tenant)
    const line = await prisma.whatsappLine.findFirst({
      where: { id: lineId, userId },
      select: { id: true },
    });

    if (!line) {
      return NextResponse.json({ ok: false, error: "Línea inexistente o no te pertenece" }, { status: 403 });
    }

    // 2) Conectar en WA server PASANDO ownerId (CLAVE)
    const r = await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: userId }),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return NextResponse.json({ ok: false, error: data?.error || "Error conectando WA" }, { status: 500 });
    }

    // 3) Guardar/actualizar en Supabase wa_lines (owner_id = userId)
    const { error } = await supabaseAdmin
      .from("wa_lines")
      .upsert(
        {
          external_line_id: lineId,
          owner_id: userId,
          wa_phone: data?.phoneNumber || null,
          status: data?.status || "connected",
          updated_at: new Date().toISOString(),
          last_assigned_at: new Date().toISOString(),
        },
        { onConflict: "external_line_id" }
      );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}

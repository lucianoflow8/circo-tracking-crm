// app/api/whatsapp-lines/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin"; // 👈 AGREGAR

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as any));
    const name = body?.name;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ ok: false, error: "El nombre es requerido" }, { status: 400 });
    }

    // 1) Prisma
    const line = await prisma.whatsappLine.create({
      data: {
        userId,
        name: String(name).trim(),
        status: "disconnected",
      },
    });

    // 2) Supabase (fuente de verdad para landings/rotación)
    // Creamos la fila wa_lines desde ya con owner_id, así el WA-SERVER luego solo UPDATEA wa_phone/status
    const { error: waErr } = await supabaseAdmin
      .from("wa_lines")
      .upsert(
        {
          external_line_id: line.id,
          owner_id: userId,
          label: line.name,
          status: "disconnected",
          wa_phone: null,
          last_assigned_at: null,
        },
        { onConflict: "external_line_id" }
      );

    if (waErr) {
      console.error("[whatsapp-lines] upsert wa_lines error:", waErr.message);
      // no cortamos; la línea ya existe en Prisma
    }

    return NextResponse.json({
      ok: true,
      line: {
        id: line.id,
        name: line.name,
        phoneNumber: line.phoneNumber,
        status: line.status,
        createdAt: line.createdAt.toISOString(),
      },
    });
  } catch (e: any) {
    console.error("[whatsapp-lines] POST error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error al crear la línea" },
      { status: 500 }
    );
  }
}

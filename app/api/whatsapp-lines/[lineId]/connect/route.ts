import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: { lineId: string } }
) {
  try {
    const lineId = params.lineId; // este es external_line_id (cmj1...)
    const WA_SERVER_URL = process.env.WA_SERVER_URL;

    if (!WA_SERVER_URL) {
      return NextResponse.json({ ok: false, error: "Falta WA_SERVER_URL en env" }, { status: 500 });
    }

    // 1) Conectar en el WA server
    const r = await fetch(`${WA_SERVER_URL}/lines/${lineId}/connect`, { method: "POST" });
    const data = await r.json().catch(() => ({}));

    if (!r.ok) {
      return NextResponse.json({ ok: false, error: data?.error || "Error conectando WA" }, { status: 500 });
    }

    // 2) Guardar/actualizar en Supabase wa_lines
    const ownerId = process.env.WA_FALLBACK_OWNER_ID || null; // si querés fijo por ahora

    const { error } = await supabaseAdmin
      .from("wa_lines")
      .upsert(
        {
          external_line_id: lineId,
          owner_id: ownerId,
          wa_phone: data?.phoneNumber || null,
          status: data?.status || "connected",
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

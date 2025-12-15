import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function POST(
  req: NextRequest,
  { params }: { params: { lineId: string } }
) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const lineId = params.lineId; // external_line_id (cmj1...)
    const WA_SERVER_URL = process.env.WA_SERVER_URL;

    if (!WA_SERVER_URL) {
      return NextResponse.json(
        { ok: false, error: "Falta WA_SERVER_URL en env" },
        { status: 500 }
      );
    }

    // 1) Conectar en el WA server ENVIANDO ownerId
    const r = await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/connect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ownerId: userId }),
    });

    const data = await r.json().catch(() => ({} as any));

    if (!r.ok) {
      return NextResponse.json(
        { ok: false, error: data?.error || "Error conectando WA" },
        { status: 500 }
      );
    }

    // 2) Asegurar fila en wa_lines (aunque phoneNumber venga null hasta "ready")
    const { error } = await supabaseAdmin
      .from("wa_lines")
      .upsert(
        {
          external_line_id: lineId,
          owner_id: userId,
          wa_phone: data?.phoneNumber || null,
          status: data?.status || "connecting",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "external_line_id" }
      );

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // 3) MULTIUSUARIO: asegurar relación landing_lines
    //    - a) todas las landings del usuario -> esta línea
    //    - b) (opcional) si tu tabla landing_lines tiene owner_id, lo guardamos
    try {
      const { data: landings, error: landErr } = await supabaseAdmin
        .from("landing_pages")
        .select("id")
        .eq("owner_id", userId);

      if (!landErr && Array.isArray(landings) && landings.length) {
        const rows = landings.map((l) => ({
          landing_id: l.id,
          wa_line_id: lineId,  // <- IMPORTANTE: acá guardamos el external_line_id (cmj...)
          owner_id: userId,    // si tu tabla no tiene owner_id, borrá esta línea
        }));

        // Si tu constraint se llama distinto, ajustá onConflict según tu schema
        await supabaseAdmin
          .from("landing_lines")
          .upsert(rows, { onConflict: "landing_id,wa_line_id" });
      }
    } catch (e: any) {
      console.log("[connect] landing_lines sync warn:", e?.message || e);
    }

    return NextResponse.json({ ok: true, ...data });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "error" },
      { status: 500 }
    );
  }
}
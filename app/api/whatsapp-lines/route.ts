import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    // opcional: filtrar por owner (si querés)
    const ownerId = req.nextUrl.searchParams.get("ownerId");

    let q = supabaseAdmin
      .from("wa_lines")
      .select("id, owner_id, external_line_id, wa_phone, status, created_at, last_assigned_at")
      .order("created_at", { ascending: false });

    if (ownerId) q = q.eq("owner_id", ownerId);

    const { data, error } = await q;

    if (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    // devolvemos lineId = external_line_id (el que usa wa-server)
    const lines = (data || []).map((r) => ({
      id: r.external_line_id,          // <- este es el lineId real
      ownerId: r.owner_id,
      phoneNumber: r.wa_phone,
      status: r.status,
      createdAt: r.created_at,
      lastAssignedAt: r.last_assigned_at,
      _dbId: r.id,                     // uuid interno por si lo querés
    }));

    return NextResponse.json({ ok: true, lines });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "error" }, { status: 500 });
  }
}

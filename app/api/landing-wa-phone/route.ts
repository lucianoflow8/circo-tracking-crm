import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function buildWaLink(phone: string, text?: string | null) {
  const clean = (phone || "").replace(/\D/g, "");
  if (!clean) return null;
  if (!text) return `https://wa.me/${clean}`;
  return `https://wa.me/${clean}?text=${encodeURIComponent(text)}`;
}

export async function GET(req: NextRequest) {
  try {
    const SUPABASE_URL =
      process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json(
        { ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY" },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { searchParams } = new URL(req.url);
    const landingIdParam = searchParams.get("landingId");
    const slugParam = searchParams.get("slug");
    const presetText = searchParams.get("text");

    // 1) Resolver landing
    let landing: any = null;

    if (landingIdParam) {
      const { data } = await supabase
        .from("landing_pages")
        .select("id, slug, owner_id")
        .eq("id", landingIdParam)
        .maybeSingle();
      landing = data || null;
    }

    if (!landing && slugParam) {
      const { data } = await supabase
        .from("landing_pages")
        .select("id, slug, owner_id")
        .eq("slug", slugParam)
        .maybeSingle();
      landing = data || null;
    }

    if (!landing?.id) {
      return NextResponse.json(
        { ok: false, error: "Landing no encontrada (landingId o slug)" },
        { status: 404 }
      );
    }

    const ownerId = landing.owner_id as string | null;
    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "Landing sin owner_id (no se puede asignar línea por cuenta)" },
        { status: 400 }
      );
    }

    // 2) Traer líneas conectadas del dueño
    const { data: lines, error: linesErr } = await supabase
      .from("wa_lines")
      .select("id, external_line_id, wa_phone, status, updated_at")
      .eq("owner_id", ownerId)
      .eq("status", "connected")
      .not("wa_phone", "is", null);

    if (linesErr) {
      return NextResponse.json(
        { ok: false, error: "Error leyendo wa_lines: " + linesErr.message },
        { status: 500 }
      );
    }

    const connected = (lines || []).filter((l: any) => !!l.wa_phone);
    if (!connected.length) {
      return NextResponse.json(
        { ok: false, error: "No hay líneas conectadas para este dueño (wa_phone vacío)" },
        { status: 400 }
      );
    }

    // 3) Round-robin por landing_rr_state
    const { data: rr } = await supabase
      .from("landing_rr_state")
      .select("landing_id, rr_index")
      .eq("landing_id", landing.id)
      .maybeSingle();

    const rrIndex = Number(rr?.rr_index || 0);

    // orden estable
    const sorted = [...connected].sort((a: any, b: any) =>
      String(a.external_line_id).localeCompare(String(b.external_line_id))
    );

    const chosen = sorted[rrIndex % sorted.length];
    const nextIndex = (rrIndex + 1) % sorted.length;

    await supabase
      .from("landing_rr_state")
      .upsert(
        { landing_id: landing.id, rr_index: nextIndex, updated_at: new Date().toISOString() },
        { onConflict: "landing_id" }
      );

    const waPhone = String(chosen.wa_phone || "");
    const waLink = buildWaLink(waPhone, presetText);

    return NextResponse.json({
      ok: true,
      landingId: landing.id,
      slug: landing.slug,
      ownerId,
      lineId: String(chosen.external_line_id),
      waPhone,
      waLink,
    });
  } catch (e: any) {
    console.error("[landing-wa-phone] EX:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error interno" },
      { status: 500 }
    );
  }
}

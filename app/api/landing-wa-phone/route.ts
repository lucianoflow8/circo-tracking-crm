// app/api/landing-wa-phone/route.ts
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
    const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SERVICE_KEY) {
      return NextResponse.json(
        { ok: false, error: "Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY en el server" },
        { status: 500 }
      );
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

    const { searchParams } = new URL(req.url);
    const landingIdParam = searchParams.get("landingId");
    const slugParam = searchParams.get("slug");
    const presetText = searchParams.get("text");

    // 1) Resolver landing (IMPORTANTE: owner_id)
    let landing: any = null;

    if (landingIdParam) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, slug, owner_id")
        .eq("id", landingIdParam)
        .maybeSingle();
      if (error) console.error("[landing-wa-phone] landing by id error:", error.message);
      landing = data || null;
    }

    if (!landing && slugParam) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, slug, owner_id")
        .eq("slug", slugParam)
        .maybeSingle();
      if (error) console.error("[landing-wa-phone] landing by slug error:", error.message);
      landing = data || null;
    }

    if (!landing?.id) {
      return NextResponse.json(
        { ok: false, error: "Landing no encontrada (landingId o slug)" },
        { status: 404 }
      );
    }

    const ownerId = String(landing.owner_id || "");
    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "Landing sin owner_id (no se puede resolver líneas por cuenta)" },
        { status: 500 }
      );
    }

    // 2) Intentar landing_lines (si existen), si no hay -> fallback por owner
    let allowedIds: string[] = [];

    const { data: landingLines, error: llErr } = await supabase
      .from("landing_lines")
      .select("wa_line_external_id, enabled")
      .eq("landing_id", landing.id);

    if (!llErr && Array.isArray(landingLines) && landingLines.length) {
      allowedIds = landingLines
        .filter((x: any) => x.enabled !== false)
        .map((x: any) => String(x.wa_line_external_id))
        .filter(Boolean);
    }

    let linesQuery = supabase
      .from("wa_lines")
      .select("id, external_line_id, wa_phone, status, last_assigned_at, updated_at, owner_id")
      .eq("owner_id", ownerId)
      .not("wa_phone", "is", null);

    if (allowedIds.length) {
      linesQuery = linesQuery.in("external_line_id", allowedIds);
    }

    const { data: lines, error: linesErr } = await linesQuery;

    if (linesErr) {
      console.error("[landing-wa-phone] wa_lines error:", linesErr.message);
      return NextResponse.json({ ok: false, error: "Error leyendo wa_lines" }, { status: 500 });
    }

    const connected = (lines || []).filter((l: any) => l.status === "connected");

    if (!connected.length) {
      return NextResponse.json(
        { ok: false, error: "No hay líneas conectadas para esta cuenta" },
        { status: 400 }
      );
    }

    // 3) Round-robin por landing_rr_state
    const { data: rr, error: rrErr } = await supabase
      .from("landing_rr_state")
      .select("landing_id, rr_index")
      .eq("landing_id", landing.id)
      .maybeSingle();

    if (rrErr) console.error("[landing-wa-phone] rr_state read error:", rrErr.message);

    const rrIndex = Number(rr?.rr_index || 0);

    const sorted = [...connected].sort((a: any, b: any) => {
      const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0;
      const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0;
      if (aTime !== bTime) return aTime - bTime;
      return String(a.external_line_id).localeCompare(String(b.external_line_id));
    });

    const chosen = sorted[rrIndex % sorted.length];

    const nextIndex = (rrIndex + 1) % sorted.length;

    await supabase
      .from("landing_rr_state")
      .upsert(
        { landing_id: landing.id, rr_index: nextIndex, updated_at: new Date().toISOString() },
        { onConflict: "landing_id" }
      );

    await supabase
      .from("wa_lines")
      .update({ last_assigned_at: new Date().toISOString() })
      .eq("id", chosen.id);

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
    return NextResponse.json({ ok: false, error: e?.message || "Error interno" }, { status: 500 });
  }
}

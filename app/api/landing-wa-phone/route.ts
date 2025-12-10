// app/api/landing-wa-phone/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const dynamic = "force-dynamic";
export const revalidate = 0;

// helper: arma link de WhatsApp tipo wa.me
function buildWaLink(phone: string, text?: string | null) {
  const clean = (phone || "").replace(/\D/g, "");
  if (!clean) return null;

  if (!text) {
    return `https://wa.me/${clean}`;
  }
  const encoded = encodeURIComponent(text);
  return `https://wa.me/${clean}?text=${encoded}`;
}

export async function GET(req: NextRequest) {
  try {
    // ====== ENV Y CLIENT (ahora ADENTRO del try, así no revienta el módulo) ======
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_SERVICE_KEY =
      process.env.SUPABASE_SERVICE_ROLE_KEY ||
      process.env.SUPABASE_SERVICE_KEY;

    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
      console.error(
        "[API/landing-wa-phone] Faltan SUPABASE_URL o SERVICE_KEY en .env"
      );
      return NextResponse.json(
        { error: "Supabase no configurado en el servidor" },
        { status: 500 }
      );
    }

    const DEFAULT_LANDING_ID = process.env.DEFAULT_LANDING_ID || null;
    const DEFAULT_LANDING_SLUG = process.env.DEFAULT_LANDING_SLUG || null;

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // ====== PARAMS ======
    const { searchParams } = new URL(req.url);
    const landingIdParam = searchParams.get("landingId");
    const slugParam = searchParams.get("slug");
    const presetText = searchParams.get("text"); // opcional: texto prellenado

    // ====== 1) Resolver landing objetivo (id + owner_id) ======
    let landingId: string | null = null;
    let landingOwnerId: string | null = null;

    if (landingIdParam) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, owner_id")
        .eq("id", landingIdParam)
        .maybeSingle();

      if (error) {
        console.error(
          "[API/landing-wa-phone] Error buscando landing por id:",
          error.message
        );
      } else if (data) {
        landingId = data.id;
        landingOwnerId = (data as any).owner_id ?? null;
      }
    } else if (slugParam) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, owner_id")
        .eq("slug", slugParam)
        .maybeSingle();

      if (error) {
        console.error(
          "[API/landing-wa-phone] Error buscando landing por slug:",
          error.message
        );
      } else if (data) {
        landingId = data.id;
        landingOwnerId = (data as any).owner_id ?? null;
      }
    }

    // Fallback a DEFAULT_LANDING_ID / SLUG si no se encontró nada
    if (!landingId && DEFAULT_LANDING_ID) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, owner_id")
        .eq("id", DEFAULT_LANDING_ID)
        .maybeSingle();

      if (!error && data) {
        landingId = data.id;
        landingOwnerId = (data as any).owner_id ?? null;
      }
    } else if (!landingId && DEFAULT_LANDING_SLUG) {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("id, owner_id")
        .eq("slug", DEFAULT_LANDING_SLUG)
        .maybeSingle();

      if (!error && data) {
        landingId = data.id;
        landingOwnerId = (data as any).owner_id ?? null;
      }
    }

    // ====== 2) Buscar líneas conectadas para ese dueño ======
    let query = supabase
      .from("wa_lines")
      .select(
        "id, external_line_id, wa_phone, status, last_assigned_at, owner_id"
      )
      .not("wa_phone", "is", null);

    if (landingOwnerId) {
      // filtramos por dueño si la landing lo tiene seteado
      query = query.eq("owner_id", landingOwnerId);
    } else {
      console.log(
        "[API/landing-wa-phone] landing sin owner_id → usando líneas globales (todas las conectadas)"
      );
    }

    const { data: lines, error: linesError } = await query;

    if (linesError) {
      console.error(
        "[API/landing-wa-phone] Error leyendo wa_lines:",
        linesError.message
      );
      return NextResponse.json(
        { error: "Error al leer líneas de WhatsApp" },
        { status: 500 }
      );
    }

    const connected = (lines || []).filter(
      (l: any) => l.status === "connected"
    );

    if (!connected.length) {
      return NextResponse.json(
        { error: "No hay líneas de WhatsApp conectadas para este dueño" },
        { status: 400 }
      );
    }

    // ====== 3) Elegir la línea con last_assigned_at más viejito (o null primero) ======
    const sorted = [...connected].sort((a: any, b: any) => {
      const aTime = a.last_assigned_at
        ? new Date(a.last_assigned_at).getTime()
        : 0;
      const bTime = b.last_assigned_at
        ? new Date(b.last_assigned_at).getTime()
        : 0;
      return aTime - bTime;
    });

    const chosen: any = sorted[0];
    const waPhone: string = chosen.wa_phone;
    const lineId: string = chosen.external_line_id;

    // ====== 4) Marcar que esta línea fue asignada recién ======
    const { error: updateLineError } = await supabase
      .from("wa_lines")
      .update({ last_assigned_at: new Date().toISOString() })
      .eq("id", chosen.id);

    if (updateLineError) {
      console.error(
        "[API/landing-wa-phone] Error actualizando last_assigned_at:",
        updateLineError.message
      );
      // no cortamos la respuesta
    }

    // ====== 5) (Opcional) actualizar landing_pages.wa_phone ======
    if (landingId && waPhone) {
      const { error: updateLandingError } = await supabase
        .from("landing_pages")
        .update({ wa_phone: waPhone })
        .eq("id", landingId);

      if (updateLandingError) {
        console.error(
          "[API/landing-wa-phone] Error actualizando landing_pages.wa_phone:",
          updateLandingError.message
        );
      } else {
        console.log(
          "[API/landing-wa-phone] wa_phone actualizado para landing",
          landingId,
          "→",
          waPhone
        );
      }
    }

    // ====== 6) Armar link de WhatsApp ======
    const waLink = buildWaLink(waPhone, presetText);

    return NextResponse.json({
      ok: true,
      lineId,
      waPhone,
      waLink,
      ownerId: landingOwnerId ?? null,
    });
  } catch (e: any) {
    console.error("[API/landing-wa-phone] Excepción general:", e);
    return NextResponse.json(
      { error: "Error interno en landing-wa-phone" },
      { status: 500 }
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUserId } from "@/lib/auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET: lista SOLO las landings del usuario logueado
export async function GET() {
  const ownerId = await getCurrentUserId();

  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const { data, error } = await supabase
    .from("landing_pages")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("GET /api/pages error", error);
    return NextResponse.json({ error: "Error al cargar páginas" }, { status: 500 });
  }

  return NextResponse.json({ pages: data ?? [] });
}

// POST: crea landing para el usuario logueado + la asocia a sus líneas (multiusuario automático)
export async function POST(req: NextRequest) {
  const ownerId = await getCurrentUserId();

  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const body = await req.json();
  const {
    internal_name,
    slug,
    content,
    wa_message,
    meta_pixel_id,
    meta_access_token,
  } = body || {};

  if (!internal_name || !slug) {
    return NextResponse.json(
      { error: "internal_name y slug son requeridos" },
      { status: 400 }
    );
  }

  const safeContent = content && typeof content === "object" ? content : {};

  const { data: page, error } = await supabase
    .from("landing_pages")
    .insert({
      internal_name,
      slug,
      content: safeContent,
      wa_message: wa_message ?? null,
      meta_pixel_id: meta_pixel_id ?? null,
      meta_access_token: meta_access_token ?? null,
      owner_id: ownerId,
    })
    .select("*")
    .single();

  if (error) {
    console.error("POST /api/pages error", error);
    return NextResponse.json({ error: "Error al crear página" }, { status: 500 });
  }

  // MULTIUSUARIO: asociar esta landing a TODAS las líneas del usuario
  try {
    const { data: lines, error: linesErr } = await supabase
      .from("wa_lines")
      .select("external_line_id")
      .eq("owner_id", ownerId);

    if (!linesErr && Array.isArray(lines) && lines.length) {
      const rows = lines
        .map((l) => l.external_line_id)
        .filter(Boolean)
        .map((externalLineId) => ({
          landing_id: page.id,
          wa_line_id: externalLineId, // guardamos el external_line_id (cmj...)
          owner_id: ownerId,          // si tu landing_lines no tiene owner_id, borrá esta línea
        }));

      await supabase
        .from("landing_lines")
        .upsert(rows, { onConflict: "landing_id,wa_line_id" });
    }
  } catch (e: any) {
    console.log("[pages] landing_lines upsert warn:", e?.message || e);
  }

  return NextResponse.json({ page });
}
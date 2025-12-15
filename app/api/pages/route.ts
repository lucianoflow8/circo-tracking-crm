// app/api/pages/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUserId } from "@/lib/auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function GET() {
  const ownerId = await getCurrentUserId();
  if (!ownerId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const { data, error } = await supabase
    .from("landing_pages")
    .select("*")
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: "Error al cargar páginas" }, { status: 500 });
  return NextResponse.json({ pages: data ?? [] });
}

export async function POST(req: NextRequest) {
  const ownerId = await getCurrentUserId();
  if (!ownerId) return NextResponse.json({ error: "No autenticado" }, { status: 401 });

  const body = await req.json();
  const { internal_name, slug, content, wa_message, meta_pixel_id, meta_access_token } = body || {};

  if (!internal_name || !slug) {
    return NextResponse.json({ error: "internal_name y slug son requeridos" }, { status: 400 });
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

  if (error) return NextResponse.json({ error: "Error al crear página" }, { status: 500 });

  // Asociar landing a TODAS las líneas del usuario -> landing_lines(landing_id, wa_line_external_id)
  try {
    const { data: lines } = await supabase
      .from("wa_lines")
      .select("external_line_id")
      .eq("owner_id", ownerId);

    const rows =
      (lines || [])
        .map((l: any) => l.external_line_id)
        .filter(Boolean)
        .map((externalId: string) => ({
          landing_id: page.id,
          wa_line_external_id: externalId,
          enabled: true,
        }));

    if (rows.length) {
      await supabase.from("landing_lines").upsert(rows, {
        onConflict: "landing_id,wa_line_external_id",
      });
    }
  } catch {}

  return NextResponse.json({ page });
}
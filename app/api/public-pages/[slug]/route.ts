// app/api/public-pages/[slug]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Helper para soportar params como objeto o Promise (Next 16)
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

export async function GET(
  _req: NextRequest,
  context: { params: { slug: string } | Promise<{ slug: string }> }
) {
  // ⬅️ acá “desempaquetamos” params, da igual si viene como Promise o no
  const { slug } = await unwrapParams(context.params);

  const { data, error } = await supabase
    .from("landing_pages")
    .select("id, name, slug, settings, created_at")
    .eq("slug", slug)
    .single();

  if (error || !data) {
    console.error("GET /api/public-pages/[slug] error", error);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const settings = (data.settings as any) || {};
  // sacamos el access token antes de mandarlo al front
  const { metaAccessToken, ...safeSettings } = settings;

  return NextResponse.json({
    page: { ...data, settings: safeSettings },
  });
}
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

export async function GET(
  _req: NextRequest,
  context: { params: { slug: string } | Promise<{ slug: string }> }
) {
  const { slug } = await unwrapParams(context.params);

  const { data, error } = await supabase
    .from("landing_pages")
    .select("id, slug, title, wa_phone, meta_pixel_id, created_at, updated_at")
    .eq("slug", slug)
    .maybeSingle();

  if (error || !data) {
    console.error("GET /api/public-pages/[slug] error", error);
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // ⚠️ NO mandamos meta_access_token al front
  return NextResponse.json({ page: data });
}

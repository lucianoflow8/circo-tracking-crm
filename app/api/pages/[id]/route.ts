// app/api/pages/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUserId } from "@/lib/auth";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

type ParamsContext = { params: Promise<{ id: string }> };

// ========= GET: trae UNA landing si es del dueño =========
export async function GET(_req: NextRequest, context: ParamsContext) {
  const { id } = await context.params;

  const ownerId = await getCurrentUserId();
  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  if (!id) {
    return NextResponse.json({ error: "ID requerido" }, { status: 400 });
  }

  const { data, error } = await supabase
    .from("landing_pages")
    .select("*")
    .eq("id", id)
    .eq("owner_id", ownerId)
    .single();

  if (error || !data) {
    console.error("GET /api/pages/[id] error", error);
    return NextResponse.json({ error: "No encontrada" }, { status: 404 });
  }

  return NextResponse.json({ page: data });
}

// ========= PUT: actualizar landing del dueño =========
export async function PUT(req: NextRequest, context: ParamsContext) {
  const { id } = await context.params;

  const ownerId = await getCurrentUserId();
  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  if (!id) {
    return NextResponse.json({ error: "ID requerido" }, { status: 400 });
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

  const { data, error } = await supabase
    .from("landing_pages")
    .update({
      internal_name,
      slug,
      content: safeContent,
      wa_message: wa_message ?? null,
      meta_pixel_id: meta_pixel_id ?? null,
      meta_access_token: meta_access_token ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("owner_id", ownerId)
    .select("*")
    .single();

  if (error || !data) {
    console.error("PUT /api/pages/[id] error", error);
    return NextResponse.json(
      { error: "Error al actualizar página" },
      { status: 500 }
    );
  }

  return NextResponse.json({ page: data });
}

// ========= DELETE: borrar landing del dueño =========
export async function DELETE(_req: NextRequest, context: ParamsContext) {
  const { id } = await context.params;

  const ownerId = await getCurrentUserId();
  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  if (!id) {
    return NextResponse.json(
      { error: "ID requerido para borrar página" },
      { status: 400 }
    );
  }

  const { error } = await supabase
    .from("landing_pages")
    .delete()
    .eq("id", id)
    .eq("owner_id", ownerId);

  if (error) {
    console.error("DELETE /api/pages/[id] error", error);
    return NextResponse.json(
      { error: "Error al borrar página" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
// app/api/whatsapp-lines/claim/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentOwnerId } from "@/lib/auth"; // alias de getCurrentUserId

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!
);

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const externalLineId = body.externalLineId as string | undefined;

    if (!externalLineId) {
      return NextResponse.json(
        { error: "externalLineId requerido" },
        { status: 400 }
      );
    }

    // 👇 SIN pasar req, la función no recibe parámetros
    const ownerId = await getCurrentOwnerId();

    if (!ownerId) {
      return NextResponse.json(
        { error: "No hay dueño autenticado" },
        { status: 401 }
      );
    }

    const { error } = await supabase
      .from("wa_lines")
      .update({ owner_id: ownerId })
      .eq("external_line_id", externalLineId);

    if (error) {
      console.error("[API/wa-lines/claim] Error:", error.message);
      return NextResponse.json(
        { error: "Error al reclamar línea" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[API/wa-lines/claim] Excepción:", e);
    return NextResponse.json(
      { error: "Error interno" },
      { status: 500 }
    );
  }
}
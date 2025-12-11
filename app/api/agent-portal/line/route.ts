// app/api/agent-portal/line/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin"; // 👈 usamos el admin, no el anon

function generateToken(len = 40) {
  const chars =
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let s = "";
  for (let i = 0; i < len; i++) {
    s += chars[Math.floor(Math.random() * chars.length)];
  }
  return s;
}

export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        { ok: false, error: "No autenticado" },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({} as any));
    const { lineId } = body || {};

    if (!lineId) {
      return NextResponse.json(
        { ok: false, error: "Falta lineId" },
        { status: 400 }
      );
    }

    // Verificamos que la línea sea del usuario actual
    const line = await prisma.whatsappLine.findFirst({
      where: { id: lineId, userId },
      select: { id: true, name: true },
    });

    if (!line) {
      return NextResponse.json(
        { ok: false, error: "Línea no encontrada o no pertenece al usuario" },
        { status: 404 }
      );
    }

    // Intentamos reutilizar un portal existente para esa línea
    const { data: existing, error: selError } = await supabaseAdmin
      .from("agent_portals")
      .select("id, token, enabled, line_ids")
      .eq("owner_user_id", userId)
      .eq("mode", "single")
      .contains("line_ids", [lineId])
      .maybeSingle();

    if (selError) {
      console.error("[AGENT-PORTAL/LINE] Error select:", selError);
    }

    let finalToken: string;

    if (existing && existing.enabled !== false) {
      // Reutilizamos token existente
      finalToken = existing.token as string;
    } else {
      // Creamos un nuevo portal para esta línea
      const token = generateToken();

      const { error: insError } = await supabaseAdmin
        .from("agent_portals")
        .insert({
          token,
          owner_user_id: userId,
          mode: "single",
          line_ids: [lineId],
          enabled: true,
        });

      if (insError) {
        console.error("[AGENT-PORTAL/LINE] Error insert:", insError);
        return NextResponse.json(
          {
            ok: false,
            error: "No se pudo crear el link de cajero",
            detail: insError.message ?? null,
          },
          { status: 500 }
        );
      }

      finalToken = token;
    }

    const origin = req.nextUrl.origin;
    const portalUrl = `${origin}/portal/${finalToken}`;

    return NextResponse.json(
      {
        ok: true,
        portalUrl,
      },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[AGENT-PORTAL/LINE] Excepción:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || "Error interno al generar link de cajero",
      },
      { status: 500 }
    );
  }
}

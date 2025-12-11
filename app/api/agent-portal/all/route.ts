// app/api/agent-portal/all/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabaseAdmin"; // ⬅️ usamos service_role

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

    // Todas las líneas del usuario
    const lines = await prisma.whatsappLine.findMany({
      where: { userId },
      select: { id: true },
    });

    if (!lines || lines.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "Todavía no tenés líneas creadas",
        },
        { status: 200 }
      );
    }

    const lineIds = lines.map((l) => l.id);

    // Buscamos si ya existe un portal 'multi' para este user
    const { data: existing, error: selError } = await supabaseAdmin
      .from("agent_portals")
      .select("id, token, enabled, line_ids")
      .eq("owner_user_id", userId)
      .eq("mode", "multi")
      .maybeSingle();

    if (selError) {
      console.error("[AGENT-PORTAL/ALL] Error select:", selError);
    }

    let finalToken: string;

    if (existing) {
      // Actualizamos las líneas y reutilizamos token
      const { error: updError } = await supabaseAdmin
        .from("agent_portals")
        .update({
          line_ids: lineIds,
          enabled: true,
        })
        .eq("id", existing.id);

      if (updError) {
        console.error("[AGENT-PORTAL/ALL] Error update:", updError);
        return NextResponse.json(
          {
            ok: false,
            error: "No se pudo actualizar el link general",
            detail: updError.message,
          },
          { status: 500 }
        );
      }

      finalToken = existing.token as string;
    } else {
      // Creamos portal nuevo
      const token = generateToken();

      const { error: insError } = await supabaseAdmin
        .from("agent_portals")
        .insert({
          token,
          owner_user_id: userId,
          mode: "multi",
          line_ids: lineIds,
          enabled: true,
        });

      if (insError) {
        console.error("[AGENT-PORTAL/ALL] Error insert:", insError);
        return NextResponse.json(
          {
            ok: false,
            error: "No se pudo crear el link general",
            detail: insError.message,
          },
          { status: 500 }
        );
      }

      finalToken = token;
    }

    const origin = req.nextUrl.origin;
    const portalUrl = `${origin}/portal/${finalToken}`;

    return NextResponse.json(
      { ok: true, portalUrl },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[AGENT-PORTAL/ALL] Excepción:", e);
    return NextResponse.json(
      {
        ok: false,
        error: e?.message || "Error interno al generar link general",
      },
      { status: 500 }
    );
  }
}
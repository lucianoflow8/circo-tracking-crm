// app/api/crm/messages/[phone]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

type RouteParams = { phone: string };

// helper para soportar params como Promise<{ phone }>
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

export async function GET(
  req: NextRequest,
  context: { params: Promise<RouteParams> }
) {
  try {
    const ownerId = await getCurrentUserId();
    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "No autenticado" },
        { status: 401 }
      );
    }

    // 👇 sacamos phone de context.params (que ahora es un Promise)
    const { phone: rawPhoneParam } = await unwrapParams(context.params);
    const rawPhone = rawPhoneParam || "";
    const phone = rawPhone.replace(/\D/g, "");

    if (!phone) {
      return NextResponse.json(
        { ok: false, error: "Teléfono inválido" },
        { status: 400 }
      );
    }

    // 1) líneas de este owner
    const { data: waLines, error: linesError } = await supabaseAdmin
      .from("wa_lines")
      .select("external_line_id")
      .eq("owner_id", ownerId);

    if (linesError) {
      console.error(
        "[API /crm/messages/:phone] Error wa_lines:",
        linesError.message
      );
      return NextResponse.json(
        { ok: false, error: "Error leyendo líneas" },
        { status: 500 }
      );
    }

    if (!waLines || waLines.length === 0) {
      return NextResponse.json({ ok: true, messages: [] });
    }

    const lineIds = waLines
      .map((l) => l.external_line_id)
      .filter((v): v is string => !!v);

    if (lineIds.length === 0) {
      return NextResponse.json({ ok: true, messages: [] });
    }

    // 2) Mensajes de ese phone pero SOLO por las líneas del owner
    const messages = await prisma.crmMessage.findMany({
      where: {
        phone,
        lineId: { in: lineIds },
      },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      ok: true,
      phone,
      messages: messages.map((m) => ({
        id: m.id,
        lineId: m.lineId,
        phone: m.phone,
        direction: m.direction,
        body: m.body,
        msgType: m.msgType,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (e: any) {
    console.error("[API /crm/messages/:phone] Excepción:", e);
    return NextResponse.json(
      { ok: false, error: "Error interno" },
      { status: 500 }
    );
  }
}
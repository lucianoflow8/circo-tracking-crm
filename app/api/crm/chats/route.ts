// app/api/crm/chats/route.ts
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getCurrentUserId } from "@/lib/auth";
import { prisma } from "@/lib/prisma"; // ajustá el import si tu prisma está en otro lado

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const ownerId = await getCurrentUserId();

    if (!ownerId) {
      return NextResponse.json(
        { ok: false, error: "No autenticado" },
        { status: 401 }
      );
    }

    // 1) Traer las líneas de este dueño
    const { data: waLines, error: linesError } = await supabaseAdmin
      .from("wa_lines")
      .select("external_line_id, wa_phone")
      .eq("owner_id", ownerId)
      .eq("status", "connected");

    if (linesError) {
      console.error("[API /crm/chats] Error wa_lines:", linesError.message);
      return NextResponse.json(
        { ok: false, error: "Error leyendo líneas" },
        { status: 500 }
      );
    }

    if (!waLines || waLines.length === 0) {
      return NextResponse.json({ ok: true, chats: [] });
    }

    const lineIds = waLines
      .map((l) => l.external_line_id)
      .filter((v): v is string => !!v);

    if (lineIds.length === 0) {
      return NextResponse.json({ ok: true, chats: [] });
    }

    // 2) Traer mensajes del CRM para esas líneas
    const messages = await prisma.crmMessage.findMany({
      where: {
        lineId: { in: lineIds },
      },
      orderBy: { createdAt: "desc" },
      take: 500, // ajustá si querés más/menos histórico
    });

    type ChatSummary = {
      phone: string;
      lastMessage: string | null;
      lastDirection: string; // 'in' | 'out'
      lastAt: string; // ISO
      lastLineId: string | null;
    };

    const map = new Map<string, ChatSummary>();

    for (const msg of messages) {
      if (!map.has(msg.phone)) {
        map.set(msg.phone, {
          phone: msg.phone,
          lastMessage: msg.body || null,
          lastDirection: msg.direction,
          lastAt: msg.createdAt.toISOString(),
          lastLineId: msg.lineId || null,
        });
      }
    }

    const chats = Array.from(map.values()).sort(
      (a, b) => new Date(b.lastAt).getTime() - new Date(a.lastAt).getTime()
    );

    return NextResponse.json({ ok: true, chats });
  } catch (e: any) {
    console.error("[API /crm/chats] Excepción:", e);
    return NextResponse.json(
      { ok: false, error: "Error interno" },
      { status: 500 }
    );
  }
}

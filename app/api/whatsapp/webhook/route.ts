import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

function normPhone(raw: string) {
  return String(raw || "").replace(/\D/g, "");
}

function isPrismaUniqueError(e: any) {
  return e?.code === "P2002";
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    const externalLineId = payload?.lineId ? String(payload.lineId) : null; // <- cmj1...
    const phone = payload?.phone ? normPhone(payload.phone) : "";
    const direction = payload?.direction ? String(payload.direction) : "";
    const waMessageId = payload?.waMessageId ? String(payload.waMessageId) : "";
    const body = payload?.body != null ? String(payload.body) : null;
    const msgType = payload?.type != null ? String(payload.type) : null;
    const createdAt =
      typeof payload?.ts === "number" && payload.ts > 0 ? new Date(payload.ts) : new Date();

    if (!phone || !direction || !waMessageId) {
      return NextResponse.json(
        { ok: false, error: "Faltan phone, direction o waMessageId" },
        { status: 400 }
      );
    }

    // ✅ ownerId sale de Supabase wa_lines (NO Prisma WhatsappLine)
    let ownerId: string | null = null;

    if (externalLineId) {
      const { data, error } = await supabaseAdmin
        .from("wa_lines")
        .select("owner_id")
        .eq("external_line_id", externalLineId)
        .maybeSingle();

      if (error) {
        console.error("[WEBHOOK] wa_lines lookup error:", error.message);
      }
      ownerId = (data?.owner_id as string | null) || null;
    }

    // fallback opcional
    if (!ownerId && process.env.WA_FALLBACK_OWNER_ID) {
      ownerId = String(process.env.WA_FALLBACK_OWNER_ID);
    }

    if (!ownerId) {
      console.warn("[WEBHOOK] ownerId no resuelto; skip save", { externalLineId, phone, waMessageId });
      return NextResponse.json({ ok: true, skipped: true, reason: "ownerId_not_found" });
    }

    // ✅ Guardar en CrmMessage
    try {
      await prisma.crmMessage.create({
        data: {
          ownerId,
          lineId: externalLineId,
          phone,
          direction,
          waMessageId,
          body,
          msgType,
          rawPayload: JSON.stringify(payload),
          createdAt,
        },
      });
    } catch (e: any) {
      if (!isPrismaUniqueError(e)) throw e;

      await prisma.crmMessage.update({
        where: { waMessageId },
        data: {
          ownerId,
          lineId: externalLineId ?? undefined,
          phone,
          direction,
          body,
          msgType,
          rawPayload: JSON.stringify(payload),
          createdAt,
        },
      });
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK] Error:", err);
    return NextResponse.json({ ok: false, error: "Error interno en webhook" }, { status: 500 });
  }
}

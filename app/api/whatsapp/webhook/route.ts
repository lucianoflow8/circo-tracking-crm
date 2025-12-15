import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Fuerza runtime node (por las dudas)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Payload = {
  lineId?: string | null;
  phone?: string | null;
  direction?: "in" | "out" | string | null;
  waMessageId?: string | null;
  body?: string | null;
  type?: string | null;
  ts?: number | null;
  media?: {
    dataUrl?: string | null;
    fileName?: string | null;
    mimetype?: string | null;
  } | null;
};

async function resolveOwnerId(lineId?: string | null) {
  const fallback = process.env.WA_FALLBACK_OWNER_ID || null;
  if (!lineId) return fallback;

  try {
    const { data, error } = await supabaseAdmin
      .from("wa_lines")
      .select("owner_id")
      .eq("external_line_id", String(lineId))
      .maybeSingle();

    if (error) {
      console.error("[WEBHOOK] Supabase wa_lines error:", error.message);
      return fallback;
    }

    return (data?.owner_id as string | undefined) || fallback;
  } catch (e: any) {
    console.error("[WEBHOOK] resolveOwnerId exception:", e?.message || e);
    return fallback;
  }
}

function parseMediaDataUrl(dataUrl?: string | null) {
  if (!dataUrl) return null;
  const m = String(dataUrl).match(/^data:(.+?);base64,(.+)$/);
  if (!m) return null;
  return { mime: m[1], b64: m[2] };
}

export async function POST(req: NextRequest) {
  let payload: Payload | null = null;

  try {
    payload = (await req.json()) as Payload;

    const lineId = payload?.lineId ? String(payload.lineId) : null;
    const phone = payload?.phone ? String(payload.phone) : null;
    const direction = payload?.direction ? String(payload.direction) : null;
    const waMessageId = payload?.waMessageId ? String(payload.waMessageId) : null;

    if (!phone || !direction || !waMessageId) {
      return NextResponse.json(
        { ok: false, error: "Faltan phone, direction o waMessageId" },
        { status: 400 }
      );
    }

    const ownerId = await resolveOwnerId(lineId);

    // Si no tenemos ownerId, NO rompemos. Devolvemos 202 y log.
    if (!ownerId) {
      console.warn("[WEBHOOK] ownerId ausente. Setear WA_FALLBACK_OWNER_ID en Vercel.", {
        lineId,
        phone,
        waMessageId,
      });
      return NextResponse.json(
        { ok: true, warning: "ownerId missing; skipped prisma insert" },
        { status: 202 }
      );
    }

    const createdAt =
      typeof payload?.ts === "number" && payload.ts > 0 ? new Date(payload.ts) : new Date();

    // Media opcional (si después querés soportarlo desde wa-server)
    const mediaParsed = parseMediaDataUrl(payload?.media?.dataUrl ?? null);

    // Guardar en CrmMessage (upsert por waMessageId)
    await prisma.crmMessage.upsert({
      where: { waMessageId },
      update: {
        ownerId,
        lineId: lineId ?? null,
        phone,
        direction,
        body: payload?.body ?? null,
        msgType: payload?.type ?? null,
        rawPayload: JSON.stringify(payload),
        createdAt,

        mediaDataUrl: payload?.media?.dataUrl ?? null,
        mediaFileName: payload?.media?.fileName ?? null,
        mediaMimeType: payload?.media?.mimetype ?? mediaParsed?.mime ?? null,
      },
      create: {
        ownerId,
        lineId: lineId ?? null,
        phone,
        direction,
        waMessageId,
        body: payload?.body ?? null,
        msgType: payload?.type ?? null,
        rawPayload: JSON.stringify(payload),
        createdAt,

        mediaDataUrl: payload?.media?.dataUrl ?? null,
        mediaFileName: payload?.media?.fileName ?? null,
        mediaMimeType: payload?.media?.mimetype ?? mediaParsed?.mime ?? null,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[WEBHOOK] Error interno:", err?.message || err, { payload });
    return NextResponse.json(
      { ok: false, error: "Error interno en webhook" },
      { status: 500 }
    );
  }
}

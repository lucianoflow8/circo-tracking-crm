// app/api/landing-events/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type EventType = "visit" | "click" | "chat" | "conversion";

interface LandingEventPayload {
  eventType: EventType;
  landingId: string;
  buttonId?: string | null;

  // WA-SERVER
  waPhone?: string | null;
  amount?: number | null;
  screenshotUrl?: string | null;

  // Para eventos del WA-SERVER: viene external_line_id (cmj...)
  waLineId?: string | null;
}

function safeNum(n: any) {
  return typeof n === "number" && !Number.isNaN(n) ? n : null;
}

function isUuid(v: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
}

async function resolveWaLineUuidFromExternal(externalLineId: string): Promise<string | null> {
  try {
    const { data, error } = await supabaseAdmin
      .from("wa_lines")
      .select("id")
      .eq("external_line_id", externalLineId)
      .maybeSingle();

    if (error) return null;
    return (data as any)?.id || null;
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LandingEventPayload;

    const { eventType, landingId, buttonId, waPhone, amount, screenshotUrl, waLineId } = body;

    if (!landingId || !eventType) {
      return NextResponse.json(
        { ok: false, error: "landingId y eventType son requeridos" },
        { status: 400 }
      );
    }

    const ipHeader = req.headers.get("x-forwarded-for") || "";
    const visitorIp = ipHeader.split(",")[0]?.trim() || null;
    const userAgent = req.headers.get("user-agent") || null;

    // =========================================================
    // 0) Resolver wa_line_id (DB) + guardar external para debug
    // =========================================================
    let waLineExternalId: string | null = waLineId ?? null;
    let waLineIdStored: string | null = null; // <-- ESTE va a la DB (ideal UUID)

    // Rotación SOLO para click y SOLO si no vino waLineId
    if (!waLineExternalId && eventType === "click") {
      const { data: landing, error: landingError } = await supabaseAdmin
        .from("landing_pages")
        .select("id, owner_id")
        .eq("id", landingId)
        .maybeSingle();

      if (landingError) {
        console.error("[landing-events] Error leyendo landing_pages:", landingError.message);
      }

      const ownerId = (landing as any)?.owner_id as string | undefined;

      if (ownerId) {
        const { data: lines, error: linesError } = await supabaseAdmin
          .from("wa_lines")
          .select("id, external_line_id, status, last_assigned_at")
          .eq("owner_id", ownerId)
          .eq("status", "connected");

        if (linesError) {
          console.error("[landing-events] Error leyendo wa_lines:", linesError.message);
        } else if (lines && lines.length > 0) {
          const sorted = [...lines].sort((a: any, b: any) => {
            const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0;
            const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0;
            return aTime - bTime;
          });

          const chosen = sorted[0] as any;

          waLineExternalId = chosen.external_line_id || null;
          waLineIdStored = chosen.id || null;

          // balance
          try {
            await supabaseAdmin
              .from("wa_lines")
              .update({ last_assigned_at: new Date().toISOString() })
              .eq("id", chosen.id);
          } catch {}
        }
      }
    }

    // Si vino waLineId del WA-SERVER (external cmj...), lo resolvemos a UUID
    if (!waLineIdStored && waLineExternalId) {
      if (isUuid(waLineExternalId)) {
        waLineIdStored = waLineExternalId;
      } else {
        waLineIdStored = await resolveWaLineUuidFromExternal(waLineExternalId);
      }
    }

    const safeAmount = safeNum(amount);

    const waPhoneToStore =
      eventType === "chat" || eventType === "conversion" ? (waPhone ?? null) : null;

    // ========================
    // 1) Guardar evento en DB
    // ========================
    const { error } = await supabaseAdmin.from("landing_events").insert({
      landing_id: landingId,
      event_type: eventType,
      button_id: buttonId ?? null,
      wa_phone: waPhoneToStore,
      amount: safeAmount,
      screenshot_url: screenshotUrl ?? null,
      visitor_ip: visitorIp,
      user_agent: userAgent,

      // OJO: guardamos UUID si existe. Si no se pudo resolver, va null (no rompe insert)
      wa_line_id: waLineIdStored ?? null,
    });

    if (error) {
      console.error("[landing-events] Error insertando evento:", error);
      return NextResponse.json(
        { ok: false, error: `DB insert failed: ${error.message}`, code: (error as any).code || null },
        { status: 500 }
      );
    }

    // ========================
    // 2) Enviar a Meta CAPI (opcional)
    // ========================
    if (eventType === "conversion" || eventType === "chat") {
      await sendMetaEvent({
        landingId,
        eventType,
        amount: safeAmount,
        visitorIp,
        userAgent,
        waPhone: waPhoneToStore,
      });
    }

    return NextResponse.json(
      { ok: true, waLineIdStored: waLineIdStored ?? null, waLineExternalId: waLineExternalId ?? null },
      { status: 200 }
    );
  } catch (e: any) {
    console.error("[landing-events] Excepción:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error interno" }, { status: 500 });
  }
}

/* ============================================================
   Meta Conversions API
   ============================================================ */
async function sendMetaEvent(opts: {
  landingId: string;
  eventType: EventType;
  amount?: number | null;
  visitorIp?: string | null;
  userAgent?: string | null;
  waPhone?: string | null;
}) {
  const { landingId, eventType, amount, visitorIp, userAgent, waPhone } = opts;

  try {
    const { data: landing, error } = await supabaseAdmin
      .from("landing_pages")
      .select("id, slug, meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .maybeSingle();

    if (error) {
      console.error("[META CAPI] Error leyendo landing_pages:", error.message);
      return;
    }
    if (!landing) return;

    const pixelId = (landing as any).meta_pixel_id as string | null;
    const accessToken = (landing as any).meta_access_token as string | null;
    if (!pixelId || !accessToken) return;

    const eventName =
      eventType === "conversion" ? "Purchase" :
      eventType === "chat" ? "Contact" : null;
    if (!eventName) return;

    const endpoint = `https://graph.facebook.com/v19.0/${pixelId}/events`;
    const eventTime = Math.floor(Date.now() / 1000);

    const user_data: Record<string, any> = {};
    if (visitorIp) user_data.client_ip_address = visitorIp;
    if (userAgent) user_data.client_user_agent = userAgent;

    // ✅ HASH DEL TELÉFONO (mejor match)
    const normalizedPhone = (waPhone || "").replace(/\D/g, "");
    if (normalizedPhone) {
      const hashedPhone = crypto.createHash("sha256").update(normalizedPhone).digest("hex");
      user_data.ph = [hashedPhone];
    }

    const custom_data: Record<string, any> = {};
    if (eventName === "Purchase" && typeof amount === "number" && amount > 0) {
      custom_data.value = amount;
      custom_data.currency = "ARS";
    }

    const PUBLIC_FRONTEND_BASE_URL =
      process.env.NEXT_PUBLIC_SITE_URL ||
      process.env.FRONTEND_BASE_URL ||
      "https://circo-tracking-crm.vercel.app";

    const event_source_url = (landing as any).slug
      ? `${PUBLIC_FRONTEND_BASE_URL}/p/${(landing as any).slug}`
      : undefined;

    const payload: any = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          action_source: "chat",
          event_source_url,
          user_data,
          ...(Object.keys(custom_data).length ? { custom_data } : {}),
        },
      ],
      access_token: accessToken,
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(`[META CAPI] Error HTTP ${eventName}:`, res.status, text);
    } else {
      console.log(`[META CAPI] ${eventName} OK ->`, landingId, waPhone || null, amount ?? null);
    }
  } catch (e) {
    console.error("[META CAPI] Excepción:", e);
  }
}
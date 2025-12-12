// app/api/landing-events/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

type EventType = "visit" | "click" | "chat" | "conversion";

interface LandingEventPayload {
  eventType: EventType;
  landingId: string;
  buttonId?: string | null;
  waPhone?: string | null;        // <-- teléfono del LEAD (jugador)
  amount?: number | null;
  screenshotUrl?: string | null;

  // IMPORTANTE:
  // Para eventos que vienen del WA-SERVER (chat/conversion), mandamos el lineId externo:
  // ej: "cmj1xvqp900052iswm7bh18bq"
  waLineId?: string | null;
}

function safeNum(n: any) {
  const v = typeof n === "number" && !Number.isNaN(n) ? n : null;
  return v;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as LandingEventPayload;

    const {
      eventType,
      landingId,
      buttonId,
      waPhone,
      amount,
      screenshotUrl,
      waLineId,
    } = body;

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
    // 0) Resolver wa_line_id (MULTI-TENANT, CONSISTENTE)
    //    Guardamos SIEMPRE external_line_id (string tipo cmj...)
    // =========================================================
    let waLineIdToStore: string | null = waLineId ?? null;

    // Si NO vino waLineId (visit/click), inferimos por landing -> owner -> wa_lines connected
    if (!waLineIdToStore) {
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
          // round-robin: elegimos la que tiene last_assigned_at más viejo
          const sorted = [...lines].sort((a: any, b: any) => {
            const aTime = a.last_assigned_at ? new Date(a.last_assigned_at).getTime() : 0;
            const bTime = b.last_assigned_at ? new Date(b.last_assigned_at).getTime() : 0;
            return aTime - bTime;
          });

          const chosen = sorted[0] as any;
          waLineIdToStore = (chosen.external_line_id as string) || null;

          // marcamos last_assigned_at para balancear
          try {
            await supabaseAdmin
              .from("wa_lines")
              .update({ last_assigned_at: new Date().toISOString() })
              .eq("id", chosen.id);
          } catch {}
        }
      }
    }

    const safeAmount = safeNum(amount);

    // ========================
    // 1) Guardar evento en DB
    // ========================
    const { error } = await supabaseAdmin.from("landing_events").insert({
      landing_id: landingId,
      event_type: eventType,
      button_id: buttonId ?? null,
      wa_phone: waPhone ?? null,
      amount: safeAmount,
      screenshot_url: screenshotUrl ?? null,
      visitor_ip: visitorIp,
      user_agent: userAgent,
      wa_line_id: waLineIdToStore ?? null, // <-- SIEMPRE external_line_id (cmj...)
    });

    if (error) {
      console.error("[landing-events] Error insertando evento:", error);
      return NextResponse.json({ ok: false, error: "Error al guardar evento" }, { status: 500 });
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
        waPhone: waPhone ?? null,
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (e: any) {
    console.error("[landing-events] Excepción:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Error interno" }, { status: 500 });
  }
}

/* ============================================================
   Meta Conversions API (si tu meta_access_token es real)
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
    if (!landing) {
      console.warn("[META CAPI] Landing no encontrada:", landingId);
      return;
    }

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
          action_source: "system_generated",
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

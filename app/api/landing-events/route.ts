// app/api/landing-events/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// 👉 ahora también acepta "conversion"
type EventType = "visit" | "click" | "chat" | "conversion";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      eventType,
      landingId,
      buttonId,
      waPhone,
      amount,        // monto opcional (conversion)
      screenshotUrl, // URL de la foto del comprobante
    }: {
      eventType: EventType;
      landingId: string;
      buttonId?: string | null;
      waPhone?: string | null;
      amount?: number | null;
      screenshotUrl?: string | null;
    } = body;

    if (!landingId || !eventType) {
      return NextResponse.json(
        { ok: false, error: "landingId y eventType son requeridos" },
        { status: 400 }
      );
    }

    const ipHeader = req.headers.get("x-forwarded-for") || "";
    const visitorIp = ipHeader.split(",")[0] || null;
    const userAgent = req.headers.get("user-agent") || null;

    const waLineId = process.env.WA_DEFAULT_LINE_ID || null;

    // ========================
    // 1) Guardar evento en DB
    // ========================
    const { error } = await supabaseAdmin.from("landing_events").insert({
      landing_id: landingId,
      event_type: eventType,
      button_id: buttonId ?? null,
      wa_phone: waPhone ?? null,
      wa_line_id: waLineId,
      visitor_ip: visitorIp,
      amount: amount ?? null,
      screenshot_url: screenshotUrl ?? null,
    });

    if (error) {
      console.error("[landing-events] Error insertando evento:", error);
      return NextResponse.json(
        { ok: false, error: error.message },
        { status: 500 }
      );
    }

    // ========================
    // 2) Enviar a Meta CAPI
    //    - conversion  -> Purchase
    //    - chat        -> Contact (mensaje/conversación)
    // ========================
    if (eventType === "conversion" || eventType === "chat") {
      await sendMetaEvent({
        landingId,
        eventType,
        amount: amount ?? null,
        visitorIp,
        userAgent,
        waPhone: waPhone ?? null,
      });
    }

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("[landing-events] Excepción:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error interno" },
      { status: 500 }
    );
  }
}

/* ============================================================
   HELPER: enviar evento a Meta Conversions API
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
    // 1) Traer pixel y access token de ESA landing
    const { data: landing, error } = await supabaseAdmin
      .from("landing_pages")
      .select("id, slug, meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .maybeSingle();

    if (error) {
      console.error(
        "[META CAPI] Error leyendo landing_pages:",
        error.message
      );
      return;
    }
    if (!landing) {
      console.warn(
        "[META CAPI] Landing no encontrada para landingId=",
        landingId
      );
      return;
    }

    const pixelId = landing.meta_pixel_id as string | null;
    const accessToken = landing.meta_access_token as string | null;

    if (!pixelId || !accessToken) {
      console.warn(
        "[META CAPI] landing sin meta_pixel_id o meta_access_token, no se envía a CAPI. landingId=",
        landingId
      );
      return;
    }

    // 2) Definir nombre de evento en Meta
    const eventName =
      eventType === "conversion"
        ? "Purchase"
        : eventType === "chat"
        ? "Contact"
        : null;

    if (!eventName) return; // solo mandamos conversion + chat

    const endpoint = `https://graph.facebook.com/v19.0/${pixelId}/events`;
    const eventTime = Math.floor(Date.now() / 1000);

    // 3) user_data mínimo (IP y User-Agent)
    const user_data: Record<string, any> = {};
    if (visitorIp) {
      user_data.client_ip_address = visitorIp;
    }
    if (userAgent) {
      user_data.client_user_agent = userAgent;
    }

    // (Opcional: podríamos hashear teléfono y mandarlo como ph más adelante)
    // if (waPhone) { ... }

    // 4) custom_data solo para Purchase
    const custom_data: Record<string, any> = {};
    if (eventName === "Purchase" && typeof amount === "number" && amount > 0) {
      custom_data.value = amount;
      custom_data.currency = "ARS";
    }

    // URL pública de la landing (si querés, ajustá a tu dominio real)
    const PUBLIC_FRONTEND_BASE_URL =
      process.env.NEXT_PUBLIC_SITE_URL || // si la tenés
      process.env.FRONTEND_BASE_URL ||    // o la misma que usás en wa-server
      "https://example.com";

    const event_source_url = landing.slug
      ? `${PUBLIC_FRONTEND_BASE_URL}/p/${landing.slug}`
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
      console.error(
        `[META CAPI] Error HTTP al enviar ${eventName}:`,
        res.status,
        text
      );
    } else {
      console.log(
        `[META CAPI] ${eventName} enviado OK → landingId=`,
        landing.id,
        "phone=",
        waPhone || null,
        "amount=",
        amount ?? null
      );
    }
  } catch (e) {
    console.error("[META CAPI] Excepción al enviar evento:", e);
  }
}
// app/api/landing-events/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export const dynamic = "force-dynamic";

// 👉 tipos que usamos en el body
type EventType = "visit" | "click" | "chat" | "conversion";

interface LandingEventPayload {
  eventType: EventType;
  landingId: string;
  buttonId?: string | null;
  waPhone?: string | null;
  amount?: number | null;
  screenshotUrl?: string | null;
  waLineId?: string | null; // opcional: permitir mandarlo explícito
}

// fallback global (para tu cuenta)
const WA_DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || null;

// ========================
//  Endpoint principal
// ========================

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

    // ========================
    // 0) Resolver wa_line_id multi-tenant
    // ========================
    let waLineIdToStore: string | null = waLineId ?? null;

    try {
      // 0.1) Si no vino waLineId explícito, inferimos por landing → owner → wa_lines
      if (!waLineIdToStore && landingId) {
        const { data: landing, error: landingError } = await supabaseAdmin
          .from("landing_pages")
          .select("id, owner_id")
          .eq("id", landingId)
          .maybeSingle();

        if (landingError) {
          console.error(
            "[landing-events] Error leyendo landing_pages:",
            landingError.message
          );
        } else if (landing && (landing as any).owner_id) {
          const ownerId = (landing as any).owner_id as string;

          let linesQuery = supabaseAdmin
            .from("wa_lines")
            .select("id, wa_phone, status, last_assigned_at")
            .eq("owner_id", ownerId)
            .eq("status", "connected");

          // Si vino waPhone, intentamos matchear esa línea
          if (waPhone) {
            linesQuery = linesQuery.eq("wa_phone", waPhone);
          }

          const { data: lines, error: linesError } = await linesQuery;

          if (linesError) {
            console.error(
              "[landing-events] Error leyendo wa_lines:",
              linesError.message
            );
          } else if (lines && lines.length > 0) {
            // Si hay varias, elegimos la de last_assigned_at más viejita
            const sorted = [...lines].sort((a: any, b: any) => {
              const aTime = a.last_assigned_at
                ? new Date(a.last_assigned_at).getTime()
                : 0;
              const bTime = b.last_assigned_at
                ? new Date(b.last_assigned_at).getTime()
                : 0;
              return aTime - bTime;
            });

            waLineIdToStore = sorted[0].id as string;
          }
        }
      }

      // 0.2) Fallback global - sólo para tu cuenta si nada matchea
      if (!waLineIdToStore && WA_DEFAULT_LINE_ID) {
        waLineIdToStore = WA_DEFAULT_LINE_ID;
      }
    } catch (err) {
      console.error(
        "[landing-events] Error resolviendo wa_line_id multi-tenant:",
        err
      );
      // si explota esto, igual seguimos y guardamos el evento sin wa_line_id
    }

    const safeAmount =
      typeof amount === "number" && !Number.isNaN(amount) ? amount : null;

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
      wa_line_id: waLineIdToStore ?? null, // 👈 multi-tenant
    });

    if (error) {
      console.error("[landing-events] Error insertando evento:", error);
      return NextResponse.json(
        { ok: false, error: "Error al guardar evento" },
        { status: 500 }
      );
    }

    // ========================
    // 2) Enviar a Meta CAPI
    //    - conversion  -> Purchase
    //    - chat        -> Contact
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

    const pixelId = (landing as any).meta_pixel_id as string | null;
    const accessToken = (landing as any).meta_access_token as string | null;

    if (!pixelId || !accessToken) {
      console.warn(
        "[META CAPI] landing sin meta_pixel_id o meta_access_token, no se envía a CAPI. landingId=",
        landingId
      );
      return;
    }

    // 2) Nombre de evento
    const eventName =
      eventType === "conversion"
        ? "Purchase"
        : eventType === "chat"
        ? "Contact"
        : null;

    if (!eventName) return; // solo mandamos conversion + chat

    const endpoint = `https://graph.facebook.com/v19.0/${pixelId}/events`;
    const eventTime = Math.floor(Date.now() / 1000);

    // 3) user_data (IP + User-Agent)
    const user_data: Record<string, any> = {};
    if (visitorIp) user_data.client_ip_address = visitorIp;
    if (userAgent) user_data.client_user_agent = userAgent;

    // 4) custom_data solo para Purchase
    const custom_data: Record<string, any> = {};
    if (eventName === "Purchase" && typeof amount === "number" && amount > 0) {
      custom_data.value = amount;
      custom_data.currency = "ARS";
    }

    // URL pública de la landing
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
      console.error(
        `[META CAPI] Error HTTP al enviar ${eventName}:`,
        res.status,
        text
      );
    } else {
      console.log(
        `[META CAPI] ${eventName} enviado OK → landingId=`,
        (landing as any).id,
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
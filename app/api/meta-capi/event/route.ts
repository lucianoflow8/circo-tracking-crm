// app/api/meta-capi/event/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

function sha256Normalize(value: string): string {
  return crypto
    .createHash("sha256")
    .update(value.trim().toLowerCase())
    .digest("hex");
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      eventName,   // "Purchase" | "Contact" | "Lead" ...
      landingId,   // id de landing_pages (uuid)
      playerPhone, // teléfono del jugador (ej: "54911...")
      value,       // monto (solo para Purchase)
      currency = "ARS",
      receiptId,   // id interno del comprobante (para event_id), opcional
    } = body || {};

    if (!eventName || !landingId || !playerPhone) {
      return NextResponse.json(
        { error: "Faltan eventName, landingId o playerPhone" },
        { status: 400 }
      );
    }

    // 1) Buscamos pixel y token en landing_pages
    const { data: landingRow, error: landingError } = await supabase
      .from("landing_pages")
      .select("meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .single();

    if (
      landingError ||
      !landingRow?.meta_pixel_id ||
      !landingRow.meta_access_token
    ) {
      console.error("Landing sin pixel/token configurado", landingError);
      return NextResponse.json(
        { error: "La landing no tiene pixel configurado" },
        { status: 400 }
      );
    }

    const pixelId = landingRow.meta_pixel_id as string;
    const accessToken = landingRow.meta_access_token as string;

    const eventTime = Math.floor(Date.now() / 1000);
    const eventId = `evt_${receiptId || eventTime}_${eventName}`;

    // user_data: por ahora solo teléfono hasheado
    const userData: any = {
      ph: [sha256Normalize(playerPhone)],
    };

    const customData: any = {};
    if (value != null) {
      customData.value = Number(value);
      customData.currency = currency;
    }

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: eventTime,
          event_id: eventId,
          action_source: "website",
          user_data: userData,
          custom_data: customData,
        },
      ],
    };

    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json();

    if (!res.ok) {
      console.error("Meta CAPI error:", json);
      return NextResponse.json(
        { error: "Error enviando evento a Meta", meta: json },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, meta: json });
  } catch (e: any) {
    console.error("Error en /api/meta-capi/event", e);
    return NextResponse.json(
      { error: "Error interno en CAPI event" },
      { status: 500 }
    );
  }
}
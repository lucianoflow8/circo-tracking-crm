// app/api/whatsapp/webhook/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import crypto from "crypto";

/**
 * Envia un evento "Contact" a Meta CAPI usando el pixel/token
 * configurado en la tabla landing_pages para esa landing.
 */
async function sendMetaContactEvent(landingId: string, playerPhone: string) {
  try {
    // 1) Buscar landing para obtener pixel + token
    const { data: landing, error } = await supabaseAdmin
      .from("landing_pages")
      .select("id, slug, meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .maybeSingle();

    if (error || !landing) {
      console.error(
        "[META CAPI] No se pudo leer landing_pages para Contact:",
        error || "landing no encontrada"
      );
      return;
    }

    const pixelId = landing.meta_pixel_id as string | null;
    const accessToken = landing.meta_access_token as string | null;

    if (!pixelId || !accessToken) {
      console.warn(
        "[META CAPI] Landing sin meta_pixel_id o meta_access_token, no se envía Contact",
        landingId
      );
      return;
    }

    // 2) Normalizar y hashear teléfono
    const normalizedPhone = (playerPhone || "").replace(/\D/g, "");
    if (!normalizedPhone) {
      console.warn(
        "[META CAPI] Phone vacío o inválido, no se envía Contact:",
        playerPhone
      );
      return;
    }

    const hashedPhone = crypto
      .createHash("sha256")
      .update(normalizedPhone)
      .digest("hex");

    const eventTime = Math.floor(Date.now() / 1000);

    const body: any = {
      data: [
        {
          event_name: "Contact",
          event_time: eventTime,
          action_source: "website",
          // podés setear un domain fijo si querés:
          // event_source_url: landing.slug
          //   ? `https://tudominio.com/p/${landing.slug}`
          //   : undefined,
          user_data: {
            ph: [hashedPhone],
          },
        },
      ],
    };

    const testCode = process.env.META_TEST_EVENT_CODE;
    if (testCode) {
      body.test_event_code = testCode;
    }

    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(
        "[META CAPI] Error HTTP al enviar Contact:",
        res.status,
        txt
      );
    } else {
      console.log("[META CAPI] Contact enviado OK", landingId, playerPhone);
    }
  } catch (e) {
    console.error("[META CAPI] Excepción enviando Contact:", e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const payload = await req.json();

    const {
      lineId,
      phone,
      direction,
      waMessageId,
      body,
      type,
      ts,
    } = payload || {};

    if (!phone || !direction || !waMessageId) {
      return NextResponse.json(
        { ok: false, error: "Faltan phone, direction o waMessageId" },
        { status: 400 }
      );
    }

    // ---- resolver ownerId desde Supabase.wa_lines ----
    let ownerId: string | null = null;

    if (lineId) {
      try {
        const { data, error } = await supabaseAdmin
          .from("wa_lines")
          .select("owner_id")
          .eq("external_line_id", String(lineId))
          .maybeSingle();

        if (error) {
          console.error(
            "[WEBHOOK wa-message] Error leyendo wa_lines:",
            error.message
          );
        } else if (data?.owner_id) {
          ownerId = data.owner_id;
        } else {
          console.warn(
            "[WEBHOOK wa-message] wa_lines sin owner_id para external_line_id",
            lineId
          );
        }
      } catch (e) {
        console.error(
          "[WEBHOOK wa-message] Excepción consultando wa_lines:",
          e
        );
      }
    }

    const createdAt =
      typeof ts === "number" && ts > 0 ? new Date(ts) : new Date();

    // ====== 1) Guardar el mensaje en Prisma (CrmMessage) ======
await prisma.crmMessage.upsert({
  where: { waMessageId },
  update: {
    ownerId: ownerId ?? undefined,  // 'undefined' es permitido para actualización
    lineId: lineId ?? undefined,    // 'undefined' es permitido para actualización
    phone,
    direction,
    body: body ?? undefined,
    msgType: type ?? undefined,
    rawPayload: JSON.stringify(payload),
    createdAt,
  },
  create: {
    // Aquí no puedes usar 'undefined' para 'ownerId'
    ownerId: ownerId ?? '', // Si ownerId es opcional y puede ser vacío, asegúrate de no pasar undefined
    lineId: lineId ?? '',   // Similar a 'ownerId'
    phone,
    direction,
    waMessageId,
    body: body ?? '',
    msgType: type ?? '',
    rawPayload: JSON.stringify(payload),
    createdAt,
  },
});

    // ====== 2) Evento de "chat" + Meta CAPI (multi-landing) ======
    try {
      // Solo nos interesan mensajes entrantes "reales"
      if (direction === "in" && type !== "e2e_notification") {
        const waLineId = lineId ? String(lineId) : null;

        if (!waLineId) {
          console.warn(
            "[WEBHOOK wa-message] Sin lineId, no se puede resolver landing para chat"
          );
        } else {
          // a) buscar el ÚLTIMO click de esa línea + teléfono
          const { data: lastClick, error: clickError } = await supabaseAdmin
            .from("landing_events")
            .select("id, landing_id")
            .eq("wa_phone", phone)
            .eq("wa_line_id", waLineId)
            .eq("event_type", "click")
            .order("created_at", { ascending: false })
            .limit(1)
            .maybeSingle();

          if (clickError) {
            console.error(
              "[WEBHOOK wa-message] Error consultando landing_events para click:",
              clickError.message
            );
          }

          if (lastClick?.landing_id) {
            const landingId = lastClick.landing_id as string;

            // b) insertamos un evento "chat" en landing_events
            try {
              await supabaseAdmin.from("landing_events").insert({
                landing_id: landingId,
                event_type: "chat",
                wa_phone: phone,
                wa_line_id: waLineId,
                created_at: new Date().toISOString(),
              });
            } catch (e: any) {
              console.error(
                "[WEBHOOK wa-message] Error insertando landing_events chat:",
                e.message || e
              );
            }

            // c) mandamos evento Contact a Meta para ESA landing
            await sendMetaContactEvent(landingId, phone);
          } else {
            console.log(
              "[WEBHOOK wa-message] No se encontró click previo en landing_events para este phone/line; no se envía Contact"
            );
          }
        }
      }
    } catch (e) {
      console.error(
        "[WEBHOOK wa-message] Excepción en lógica de chat + Meta:",
        e
      );
    }

    // =============================================
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[WEBHOOK wa-message] Error:", err);
    return NextResponse.json(
      { ok: false, error: "Error interno en webhook" },
      { status: 500 }
    );
  }
}
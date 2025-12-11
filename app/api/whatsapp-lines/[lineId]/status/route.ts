// app/api/whatsapp-lines/[lineId]/status/route.ts
import { NextResponse } from "next/server";
import QRCode from "qrcode";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

type WaStatusRaw = {
  status: "offline" | "connecting" | "qr" | "ready";
  qr?: string | null;
  phoneNumber?: string | null;
};

export async function GET(
  request: Request,
  context: { params: { lineId: string } }
) {
  const { lineId } = context.params;

  console.log("[STATUS API] Consultando estado de la línea:", lineId);
  console.log("[STATUS API] WA_SERVER_URL =", WA_SERVER_URL);

  if (!WA_SERVER_URL) {
    console.error("[STATUS API] WA_SERVER_URL no está definido");
    return NextResponse.json(
      {
        status: "connecting",
        qr: null,
        phoneNumber: null,
        error: "WA_SERVER_URL no configurado",
      },
      { status: 500 }
    );
  }

  try {
    const resp = await fetch(`${WA_SERVER_URL}/lines/${lineId}/status`, {
      cache: "no-store",
    });

    const data = (await resp.json().catch(() => ({}))) as WaStatusRaw;

    console.log("[STATUS API] Respuesta cruda del wa-server:", data);

    if (!resp.ok) {
      console.error("[STATUS API] Error del wa-server:", data);
      return NextResponse.json(
        {
          status: "connecting",
          qr: null,
          phoneNumber: null,
          error: data || "Error obteniendo status desde WhatsApp",
        },
        { status: 500 }
      );
    }

    let qrImage: string | null = null;

    // Sólo intento generar el PNG si el wa-server dice que hay QR
    if (data.status === "qr" && data.qr) {
      try {
        qrImage = await QRCode.toDataURL(data.qr);
      } catch (e) {
        console.error("[STATUS API] Error generando QR base64:", e);
      }
    }

    return NextResponse.json({
      status: data.status,
      qr: qrImage,
      phoneNumber: data.phoneNumber ?? null,
    });
  } catch (err) {
    console.error("[STATUS API] Error llamando al wa-server", err);
    return NextResponse.json(
      {
        status: "connecting",
        qr: null,
        phoneNumber: null,
        error: "No se pudo conectar con el servidor de WhatsApp",
      },
      { status: 500 }
    );
  }
}

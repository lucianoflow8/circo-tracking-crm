// app/api/whatsapp-lines/[lineId]/qr/route.ts
import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

// helper para soportar params como objeto o Promise (Next 16)
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

export async function GET(
  _req: NextRequest,
  context: { params: { lineId: string } | Promise<{ lineId: string }> }
) {
  const { lineId } = await unwrapParams(context.params);

  if (!lineId) {
    return NextResponse.json(
      { error: "lineId requerido" },
      { status: 400 }
    );
  }

  try {
    const resp = await fetch(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/qr`);
    const data = await resp.json().catch(() => ({} as any));

    if (!resp.ok) {
      console.error("[QR] Error del wa-server:", data);
      return NextResponse.json(
        { error: "Error obteniendo QR desde WhatsApp" },
        { status: 500 }
      );
    }

    return NextResponse.json({ qr: data.qr ?? null });
  } catch (err) {
    console.error("[QR] Error llamando al wa-server", err);
    return NextResponse.json(
      { error: "No se pudo conectar con el servidor de WhatsApp" },
      { status: 500 }
    );
  }
}
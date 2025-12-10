// app/api/whatsapp-lines/[lineId]/status/route.ts
import { NextResponse } from 'next/server';
import QRCode from 'qrcode';

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function GET(
  request: Request,
  context: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await context.params;

  console.log('[STATUS API] Consultando estado de la línea:', lineId);

  try {
    const resp = await fetch(`${WA_SERVER_URL}/lines/${lineId}/status`);
    const data = await resp.json().catch(() => ({} as any));

    if (!resp.ok) {
      console.error('[STATUS API] Error del wa-server:', data);
      return NextResponse.json(
        { error: data.error || 'Error obteniendo status desde WhatsApp' },
        { status: 500 }
      );
    }

    let qrImage: string | null = null;
    if (data.qr) {
      qrImage = await QRCode.toDataURL(data.qr);
    }

    return NextResponse.json({
      status: data.status,
      qr: qrImage,
      phoneNumber: data.phoneNumber ?? null,
    });
  } catch (err) {
    console.error('[STATUS API] Error llamando al wa-server', err);
    return NextResponse.json(
      { error: 'No se pudo conectar con el servidor de WhatsApp' },
      { status: 500 }
    );
  }
}

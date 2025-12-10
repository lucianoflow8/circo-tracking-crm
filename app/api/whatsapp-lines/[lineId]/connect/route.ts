// app/api/whatsapp-lines/[lineId]/connect/route.ts
import { NextResponse } from 'next/server';
import QRCode from 'qrcode';

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function POST(
  request: Request,
  context: { params: Promise<{ lineId: string }> }
) {
  // 👇 acá está la magia: esperamos el Promise
  const { lineId } = await context.params;

  console.log('[CONNECT API] Iniciando conexión para línea:', lineId);

  try {
    const resp = await fetch(`${WA_SERVER_URL}/lines/${lineId}/connect`, {
      method: 'POST',
    });

    const data = await resp.json().catch(() => ({} as any));

    if (!resp.ok) {
      console.error('[CONNECT API] Error del wa-server:', data);
      return NextResponse.json(
        { error: data.error || 'Error conectando con WhatsApp' },
        { status: 500 }
      );
    }

    // data.qr es el string del QR -> lo convertimos a imagen
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
    console.error('[CONNECT API] Error llamando al wa-server', err);
    return NextResponse.json(
      { error: 'No se pudo conectar con el servidor de WhatsApp' },
      { status: 500 }
    );
  }
}

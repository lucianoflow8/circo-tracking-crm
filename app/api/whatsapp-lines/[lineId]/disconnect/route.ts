import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await params;

  // 1) Avisamos al wa-server (pero NO bloqueamos si la sesión no existe)
  try {
    const resp = await fetch(`${WA_SERVER_URL}/lines/${lineId}/disconnect`, {
      method: 'POST',
    });

    const data = await resp.json().catch(() => ({} as any));

    if (!resp.ok && resp.status !== 404) {
      console.error('[DISCONNECT] Error wa-server', data);
      return NextResponse.json(
        { error: data.error || 'Error desconectando en wa-server' },
        { status: 500 }
      );
    }

    if (resp.status === 404) {
      console.warn(
        '[DISCONNECT] Session not found en wa-server, continuo igual y marco como desconectada'
      );
    }
  } catch (err) {
    console.error('[DISCONNECT] No se pudo llamar al wa-server', err);
    // seguimos igual, solo marcamos la línea como desconectada en la DB
  }

  // 2) Actualizamos la DB
  try {
    const updated = await prisma.whatsappLine.update({
      where: { id: lineId },
      data: {
        status: 'disconnected',
        phoneNumber: null,
        sessionData: null,
      },
    });

    return NextResponse.json({ ok: true, line: updated });
  } catch (err) {
    console.error('[DISCONNECT] Error actualizando la línea en DB', err);
    return NextResponse.json(
      { error: 'Error al actualizar la línea en la base de datos' },
      { status: 500 }
    );
  }
}

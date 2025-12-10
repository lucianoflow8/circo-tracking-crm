import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function POST(
  req: Request,
  { params }: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await params;

  // Primero intentamos desconectar en wa-server (ignorando errores)
  try {
    await fetch(`${WA_SERVER_URL}/lines/${lineId}/disconnect`, {
      method: 'POST',
    }).catch(() => {});
  } catch {
    // ignoramos
  }

  try {
    // Si en el futuro tenés contactos/mensajes, acá se podría hacer deleteMany
    await prisma.whatsappLine.delete({
      where: { id: lineId },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error('[DELETE LINE] Error eliminando línea en DB', err);
    return NextResponse.json(
      { error: 'Error al eliminar la línea en la base de datos' },
      { status: 500 }
    );
  }
}

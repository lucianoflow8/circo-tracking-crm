// app/api/chats/[chatId]/send/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ chatId: string }> }
) {
  // ⬅️ sacamos chatId desde el context (como pide Next 16)
  const { chatId } = await context.params;
  const contactId = chatId; // usamos chatId como id del Contact

  if (!contactId) {
    return NextResponse.json(
      { error: "Falta chatId en la ruta" },
      { status: 400 }
    );
  }

  const body = (await request.json().catch(() => ({} as any))) as any;
  const text = (body.text || "").trim();

  if (!text) {
    return NextResponse.json(
      { error: "El mensaje no puede estar vacío" },
      { status: 400 }
    );
  }

  try {
    const contact = await prisma.contact.findUnique({
      where: { id: contactId },
      include: { whatsappLine: true },
    });

    if (!contact || !contact.whatsappLine) {
      return NextResponse.json(
        { error: "Contacto o línea de WhatsApp no encontrada" },
        { status: 404 }
      );
    }

    const waLineId = contact.whatsappLineId;
    const phone = contact.phone;

    // Llamamos al wa-server para mandar el mensaje real
    const waResp = await fetch(
      `${WA_SERVER_URL}/lines/${waLineId}/send-text`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: phone,
          message: text,
        }),
      }
    );

    const waData = await waResp.json().catch(() => ({} as any));

    if (!waResp.ok) {
      console.error("[WA SEND] Error", waData);
      return NextResponse.json(
        { error: waData.error || "Error enviando mensaje a WhatsApp" },
        { status: 500 }
      );
    }

    // Guardamos el mensaje outbound en la base
    const message = await prisma.message.create({
      data: {
        contactId: contact.id,
        whatsappLineId: waLineId,
        direction: "outbound",
        body: text,
      },
    });

    // Actualizamos stats del contacto
    await prisma.contact.update({
      where: { id: contact.id },
      data: {
        lastMessageAt: new Date(),
        totalMessages: { increment: 1 },
      },
    });

    return NextResponse.json({ ok: true, message });
  } catch (err) {
    console.error("[SEND] Error guardando/enviando mensaje", err);
    return NextResponse.json(
      { error: "Error interno al enviar el mensaje" },
      { status: 500 }
    );
  }
}
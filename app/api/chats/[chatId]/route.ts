// app/api/chats/[chatId]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

const toDigits = (value: string | null | undefined) =>
  (value || "").replace(/\D/g, "");

// Helper para soportar params como objeto o Promise (Next 16)
async function unwrapParams<T>(params: T | Promise<T>): Promise<T> {
  return await Promise.resolve(params);
}

export async function GET(
  _req: NextRequest,
  context: { params: { chatId: string } | Promise<{ chatId: string }> }
) {
  try {
    const { chatId } = await unwrapParams(context.params);
    const phone = toDigits(chatId);

    if (!phone) {
      return NextResponse.json(
        { error: "Teléfono inválido" },
        { status: 400 }
      );
    }

    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    // Traemos todos los mensajes de ese teléfono para ese dueño
    const rows = await prisma.crmMessage.findMany({
      where: {
        phone,
        ownerId: userId,
      },
      orderBy: { createdAt: "asc" },
    });

    if (!rows.length) {
      return NextResponse.json(
        { error: "Chat not found" },
        { status: 404 }
      );
    }

    // Usamos la última línea usada con ese teléfono
    const last = rows[rows.length - 1];

    const chat = {
      id: phone, // usamos el número como id de chat
      contactName: phone, // acá luego podés enchufar un nombre “lindo”
      lineId: last.lineId,
      contactPhoneRaw: phone,
      messages: rows.map((m) => ({
        id: m.waMessageId || m.id,
        body: m.body || "",
        fromMe: m.direction === "out",
        createdAt: m.createdAt,
      })),
    };

    return NextResponse.json({ chat }, { status: 200 });
  } catch (err) {
    console.error("[API /api/chats/[chatId] GET] Error:", err);
    return NextResponse.json(
      { error: "Error interno" },
      { status: 500 }
    );
  }
}
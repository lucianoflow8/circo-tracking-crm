// app/api/whatsapp-lines/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

const WA_SERVER_URL =
  process.env.WA_SERVER_URL || "http://localhost:4002";

type LineDTO = {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  createdAt: string;
};

// Helper para preguntarle al WA-SERVER el estado real de la línea
async function fetchWaServerStatus(lineId: string): Promise<{
  status?: string;
  phoneNumber?: string | null;
} | null> {
  if (!WA_SERVER_URL) return null;

  try {
    const res = await fetch(
      `${WA_SERVER_URL}/lines/${lineId}/status`,
      { method: "GET" }
    );

    if (!res.ok) {
      // 404 = session not found → la tratamos como desconectada
      return null;
    }

    const json = await res.json().catch(() => ({} as any));

    return {
      status: json.status as string | undefined,
      phoneNumber: json.phoneNumber as string | undefined,
    };
  } catch (e) {
    console.error("[whatsapp-lines] Error consultando WA-SERVER:", e);
    return null;
  }
}

// ==========================
//   GET  -> listar líneas
// ==========================
export async function GET(_req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const lines = await prisma.whatsappLine.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const enriched: LineDTO[] = await Promise.all(
      lines.map(async (l) => {
        // Preguntamos al WA-SERVER si está conectada
        const remote = await fetchWaServerStatus(l.id);

        const status =
          remote?.status ?? l.status ?? "disconnected";
        const phoneNumber =
          (remote?.phoneNumber as string | null | undefined) ??
          l.phoneNumber ??
          null;

        return {
          id: l.id,
          name: l.name,
          phoneNumber,
          status,
          createdAt: l.createdAt.toISOString(),
        };
      })
    );

    return NextResponse.json({ lines: enriched });
  } catch (e: any) {
    console.error("[whatsapp-lines] GET error:", e);
    return NextResponse.json(
      { error: e?.message || "Error al cargar las líneas" },
      { status: 500 }
    );
  }
}

// ==========================
//   POST -> crear línea
// ==========================
export async function POST(req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        { error: "No autenticado" },
        { status: 401 }
      );
    }

    const body = await req.json().catch(() => ({} as any));
    const { name } = body || {};

    if (!name || !String(name).trim()) {
      return NextResponse.json(
        { error: "El nombre es requerido" },
        { status: 400 }
      );
    }

    const line = await prisma.whatsappLine.create({
      data: {
        userId,
        name: String(name).trim(),
        status: "disconnected",
      },
    });

    const dto: LineDTO = {
      id: line.id,
      name: line.name,
      phoneNumber: line.phoneNumber,
      status: line.status,
      createdAt: line.createdAt.toISOString(),
    };

    return NextResponse.json({ line: dto });
  } catch (e: any) {
    console.error("[whatsapp-lines] POST error:", e);
    return NextResponse.json(
      { error: e?.message || "Error al crear la línea" },
      { status: 500 }
    );
  }
}
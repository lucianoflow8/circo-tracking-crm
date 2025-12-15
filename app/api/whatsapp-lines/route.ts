// app/api/whatsapp-lines/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

// Prisma necesita Node runtime (no Edge)
export const runtime = "nodejs";
// Evita caching raro en rutas dinámicas
export const dynamic = "force-dynamic";

const WA_SERVER_URL = process.env.WA_SERVER_URL || "http://localhost:4002";

type LineDTO = {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  createdAt: string;
};

async function fetchWaServerStatus(
  lineId: string
): Promise<{ status?: string; phoneNumber?: string | null } | null> {
  try {
    const res = await fetch(`${WA_SERVER_URL}/lines/${lineId}/status`, {
      method: "GET",
      cache: "no-store",
    });

    if (!res.ok) return null;

    const json = await res.json().catch(() => ({} as any));
    return {
      status: json.status as string | undefined,
      phoneNumber: (json.phoneNumber as string | undefined) ?? null,
    };
  } catch (e) {
    console.error("[whatsapp-lines] Error consultando WA-SERVER:", e);
    return null;
  }
}

// (Opcional pero recomendado) si por algún motivo te hace preflight:
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      Allow: "GET,POST,OPTIONS",
    },
  });
}

// ==========================
//   GET  -> listar líneas
// ==========================
export async function GET(_req: NextRequest) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const lines = await prisma.whatsappLine.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

    const enriched: LineDTO[] = await Promise.all(
      lines.map(async (l) => {
        const remote = await fetchWaServerStatus(l.id);

        return {
          id: l.id,
          name: l.name,
          phoneNumber: remote?.phoneNumber ?? l.phoneNumber ?? null,
          status: remote?.status ?? l.status ?? "disconnected",
          createdAt: l.createdAt.toISOString(),
        };
      })
    );

    return NextResponse.json({ ok: true, lines: enriched });
  } catch (e: any) {
    console.error("[whatsapp-lines] GET error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error al cargar las líneas" },
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
      return NextResponse.json({ ok: false, error: "No autenticado" }, { status: 401 });
    }

    const body = await req.json().catch(() => ({} as any));
    const name = body?.name;

    if (!name || !String(name).trim()) {
      return NextResponse.json({ ok: false, error: "El nombre es requerido" }, { status: 400 });
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

    return NextResponse.json({ ok: true, line: dto });
  } catch (e: any) {
    console.error("[whatsapp-lines] POST error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error al crear la línea" },
      { status: 500 }
    );
  }
}

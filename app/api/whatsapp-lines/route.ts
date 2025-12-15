import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

const WA_SERVER_URL = process.env.WA_SERVER_URL || ""; // <-- en Vercel poné tu VPS acá

type LineDTO = {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string;
  createdAt: string;
};

// ✅ fetch con timeout (evita que Vercel se cuelgue si WA_SERVER no responde)
async function fetchWithTimeout(url: string, ms = 1500) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
    return res;
  } finally {
    clearTimeout(t);
  }
}

async function fetchWaServerStatus(
  lineId: string
): Promise<{ status?: string; phoneNumber?: string | null } | null> {
  if (!WA_SERVER_URL) return null; // sin WA_SERVER_URL, no preguntamos nada

  try {
    const res = await fetchWithTimeout(`${WA_SERVER_URL}/lines/${encodeURIComponent(lineId)}/status`, 1500);
    if (!res.ok) return null;

    const json = await res.json().catch(() => ({} as any));
    return {
      status: json.status as string | undefined,
      phoneNumber: (json.phoneNumber as string | undefined) ?? null,
    };
  } catch {
    return null; // ✅ nunca rompe la carga de líneas
  }
}

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

    return NextResponse.json({
      ok: true,
      line: {
        id: line.id,
        name: line.name,
        phoneNumber: line.phoneNumber,
        status: line.status,
        createdAt: line.createdAt.toISOString(),
      },
    });
  } catch (e: any) {
    console.error("[whatsapp-lines] POST error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message || "Error al crear la línea" },
      { status: 500 }
    );
  }
}

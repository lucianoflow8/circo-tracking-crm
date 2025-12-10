// app/api/groups/route.ts
import { NextRequest, NextResponse } from "next/server";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID!;

// POST /api/groups
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const {
      name,
      description,
      participants,
      messagesAdminsOnly,
      adminNumbers,
      // groupImage viene del front pero todavía no lo usamos en wa-server
    } = body || {};

    if (!name || !Array.isArray(participants) || participants.length === 0) {
      return NextResponse.json(
        { error: "name y participants[] son requeridos" },
        { status: 400 }
      );
    }

    const payload = {
      name,
      description: description || undefined,
      participants,
      messagesAdminsOnly: !!messagesAdminsOnly,
      adminNumbers: Array.isArray(adminNumbers) ? adminNumbers : [],
    };

    const url = `${WA_SERVER_URL}/lines/${encodeURIComponent(
      DEFAULT_LINE_ID
    )}/groups`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.error("[API/GROUPS] WA-SERVER error:", res.status, text);
      return NextResponse.json(
        { error: "Error al crear grupo en WhatsApp" },
        { status: 500 }
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.error("[API/GROUPS] Error interno:", err);
    return NextResponse.json(
      { error: "Error interno al crear grupo" },
      { status: 500 }
    );
  }
}

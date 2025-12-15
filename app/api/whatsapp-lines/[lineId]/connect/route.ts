import { NextResponse } from "next/server";
import QRCode from "qrcode";
import { getCurrentUserId } from "@/lib/auth";

const WA_SERVER_URL = process.env.WA_SERVER_URL!;

export async function POST(
  request: Request,
  context: { params: Promise<{ lineId: string }> }
) {
  const { lineId } = await context.params;

  const ownerId = await getCurrentUserId();
  if (!ownerId) {
    return NextResponse.json({ error: "No autenticado" }, { status: 401 });
  }

  const resp = await fetch(`${WA_SERVER_URL}/lines/${lineId}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ownerId }),
  });

  const data = await resp.json().catch(() => ({} as any));

  if (!resp.ok) {
    return NextResponse.json(
      { error: data.error || "Error conectando con WhatsApp" },
      { status: 500 }
    );
  }

  let qrImage: string | null = null;
  if (data.qr) qrImage = await QRCode.toDataURL(data.qr);

  return NextResponse.json({
    status: data.status,
    qr: qrImage,
    phoneNumber: data.phoneNumber ?? null,
  });
}

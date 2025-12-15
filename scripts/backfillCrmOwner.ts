// scripts/backfillCrmOwner.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const prisma = new PrismaClient();

// Requiere en .env:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_SERVICE_KEY)
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  throw new Error(
    "Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY (o SUPABASE_SERVICE_KEY) en el .env"
  );
}

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

type WaLineRow = {
  external_line_id: string | null;
  owner_id: string | null;
};

async function main() {
  console.log("=== Backfill CrmMessage.ownerId desde wa_lines ===");

  // 1) Traemos de Supabase líneas que tengan owner_id
  const { data: lines, error } = await supabaseAdmin
    .from("wa_lines")
    .select("external_line_id, owner_id")
    .not("owner_id", "is", null);

  if (error) {
    console.error("[backfillCrmOwner] Error leyendo wa_lines:", error.message);
    return;
  }

  const rows = (lines || []) as WaLineRow[];

  if (rows.length === 0) {
    console.log("[backfillCrmOwner] No hay wa_lines con owner_id, nada que hacer.");
    return;
  }

  // 2) Mapear external_line_id -> owner_id
  const map = new Map<string, string>();
  for (const r of rows) {
    const lineId = r.external_line_id ? String(r.external_line_id) : "";
    const ownerId = r.owner_id ? String(r.owner_id) : "";
    if (lineId && ownerId) map.set(lineId, ownerId);
  }

  if (map.size === 0) {
    console.log("[backfillCrmOwner] Mapa vacío (sin external_line_id/owner_id), nada que actualizar.");
    return;
  }

  console.log("[backfillCrmOwner] Líneas encontradas con owner_id:", map.size);

  // 3) Actualizar SOLO donde ownerId IS NULL (sin usar ownerId: null en Prisma where)
  let totalUpdated = 0;

  for (const [lineId, ownerId] of map.entries()) {
    const updated = await prisma.$executeRaw<number>`
      UPDATE "CrmMessage"
      SET "ownerId" = ${ownerId}
      WHERE "lineId" = ${lineId}
        AND "ownerId" IS NULL
    `;

    console.log(`Línea ${lineId} → ownerId=${ownerId} | mensajes actualizados:`, updated);
    totalUpdated += Number(updated || 0);
  }

  console.log("=== Total mensajes actualizados:", totalUpdated, "===");
}

main()
  .catch((e) => console.error(e))
  .finally(async () => {
    await prisma.$disconnect();
  });
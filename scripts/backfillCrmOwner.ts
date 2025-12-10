// scripts/backfillCrmOwner.ts
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { createClient } from "@supabase/supabase-js";

const prisma = new PrismaClient();

// ⚠️ Asegurate que estas envs estén en tu .env:
// SUPABASE_URL
// SUPABASE_SERVICE_ROLE_KEY (o SERVICE_KEY, elegí una y adaptá acá)
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY!;

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function main() {
  console.log("=== Backfill CrmMessage.ownerId desde wa_lines ===");

  // 1) Traemos de Supabase todas las líneas que tengan owner_id
  const { data: lines, error } = await supabaseAdmin
    .from("wa_lines")
    .select("external_line_id, owner_id")
    .not("owner_id", "is", null);

  if (error) {
    console.error(
      "[backfillCrmOwner] Error leyendo wa_lines:",
      error.message
    );
    return;
  }

  if (!lines || lines.length === 0) {
    console.log(
      "[backfillCrmOwner] No hay wa_lines con owner_id, nada que hacer."
    );
    return;
  }

  // 2) Mapeamos external_line_id -> owner_id
  const map = new Map<string, string>();
  for (const row of lines as any[]) {
    if (row.external_line_id && row.owner_id) {
      map.set(String(row.external_line_id), String(row.owner_id));
    }
  }

  if (map.size === 0) {
    console.log(
      "[backfillCrmOwner] Mapa vacío (sin external_line_id/owner_id), nada que actualizar."
    );
    return;
  }

  console.log(
    "[backfillCrmOwner] Líneas encontradas con owner_id:",
    map.size
  );

  // 3) Por cada línea, actualizamos los CrmMessage que tengan ese lineId y ownerId null
  let totalUpdated = 0;

  for (const [lineId, ownerId] of map.entries()) {
    const result = await prisma.crmMessage.updateMany({
      where: {
        lineId,
        ownerId: null,
      },
      data: {
        ownerId,
      },
    });

    console.log(
      `Línea ${lineId} → ownerId=${ownerId} | mensajes actualizados:`,
      result.count
    );

    totalUpdated += result.count;
  }

  console.log(
    "=== Total mensajes actualizados:",
    totalUpdated,
    "==="
  );
}

main()
  .catch((e) => {
    console.error(e);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
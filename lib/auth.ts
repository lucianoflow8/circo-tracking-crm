// lib/auth.ts
import { cookies } from "next/headers";

/**
 * Devuelve el id del usuario logueado leyendo la cookie "crm_user_id".
 */
export async function getCurrentUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get("crm_user_id");
  return cookie?.value ?? null;
}

/**
 * Devuelve el lineId (línea de WhatsApp) del usuario logueado leyendo
 * la cookie "crm_line_id".
 *
 * IMPORTANTE: esto evita mezclar chats entre cuentas.
 */
export async function getCurrentLineId(): Promise<string | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get("crm_line_id");
  return cookie?.value ?? null;
}

/**
 * Alias para compatibilidad con endpoints que usan "owner".
 */
export async function getCurrentOwnerId(): Promise<string | null> {
  return getCurrentUserId();
}

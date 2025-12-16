// wa-server.js
// Servidor intermedio entre tu app Next y whatsapp-web.js

require("dotenv").config(); // ✅ SOLO ESTA
const crypto = require("crypto");

const express = require("express");
const cors = require("cors");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { createClient } = require("@supabase/supabase-js");

/* =========================
   FETCH (Node 18+ o fallback)
   ========================= */
async function doFetch(url, options) {
  if (typeof globalThis.fetch === "function") return globalThis.fetch(url, options);
  const mod = await import("node-fetch");
  const fetchFn = mod.default || mod;
  return fetchFn(url, options);
}

/* =========================
   OCR / PDF
   ========================= */
const TesseractNS = require("tesseract.js");
const Tesseract = TesseractNS.default || TesseractNS;

const pdfParseCjs = require("pdf-parse");
const pdfParse = pdfParseCjs.default || pdfParseCjs;

let sharp = null;
try {
  sharp = require("sharp");
  console.log("[WA-SERVER] sharp cargado para OCR");
} catch (e) {
  console.log("[WA-SERVER] sharp no disponible (OCR sin preprocesado de imagen)");
}

/* =========================
   CONFIG BÁSICA
   ========================= */
const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || "http://localhost:3000";

// ✅ Asegurate que diga "webhook" con H
const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL || `${FRONTEND_BASE_URL}/api/whatsapp/webhook`;

const WA_LINES_HAS_STATUS = (process.env.WA_LINES_HAS_STATUS || "true") === "true";

/* =========================
   SUPABASE CONFIG
   ========================= */
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// ✅ En multiusuario NO usamos default para atribución (lo dejamos por compatibilidad)
const DEFAULT_LANDING_ID = process.env.DEFAULT_LANDING_ID || null;
const DEFAULT_LANDING_SLUG = process.env.DEFAULT_LANDING_SLUG || null;

const SUPABASE_BUCKET_RECEIPTS = process.env.SUPABASE_BUCKET_RECEIPTS || "receipts";

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log("[WA-SERVER] Supabase client inicializado");
} else {
  console.log(
    "[WA-SERVER] ATENCIÓN: faltan SUPABASE_URL o SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY en .env"
  );
}

/**
 * ✅ FIX: wa_lines upsert SIN romper por owner_id NOT NULL
 * - UPDATE primero (no necesita owner_id)
 * - Si no existe fila, INSERT SOLO si hay ownerId
 */
async function upsertWaLine({ lineId, phoneNumber, status, ownerId }) {
  if (!supabase) {
    console.log("[WA-SERVER] Supabase no configurado, no se guarda wa_lines");
    return;
  }
  if (!lineId) return;

  try {
    const updatePayload = {
      wa_phone: phoneNumber || null,
    };
    if (WA_LINES_HAS_STATUS) updatePayload.status = status || null;

    // 1) UPDATE primero (si existe)
    const { data: updated, error: updErr } = await supabase
      .from("wa_lines")
      .update(updatePayload)
      .eq("external_line_id", String(lineId))
      .select("id, external_line_id, wa_phone, owner_id")
      .maybeSingle();

    if (!updErr && updated) {
      console.log("[WA-SERVER] wa_lines update OK ✅", updated);
      return;
    }

    // 2) Si no existe fila, INSERT solo si hay ownerId
    if (!ownerId) {
      console.log("[WA-SERVER] wa_lines no existe y falta ownerId -> no inserto (evita error)");
      return;
    }

    const insertPayload = {
      external_line_id: String(lineId),
      owner_id: ownerId,
      ...updatePayload,
    };

    const { data: inserted, error: insErr } = await supabase
      .from("wa_lines")
      .insert(insertPayload)
      .select("id, external_line_id, wa_phone, owner_id")
      .single();

    if (insErr) {
      console.log("[WA-SERVER] Error insert wa_lines:", insErr.message);
      return;
    }

    console.log("[WA-SERVER] wa_lines insert OK ✅", inserted);
  } catch (e) {
    console.log("[WA-SERVER] Excepción upsertWaLine:", e?.message || e);
  }
}

/* =========================
   ✅ FIX: phone real si viene @lid + texto en caption
   ========================= */
async function getRealPhoneFromMsg(msg) {
  try {
    const jid = (msg?.fromMe ? msg?.to : msg?.from) || "";
    const isLid = jid.endsWith("@lid");

    let digits = (jid.split("@")[0] || "").replace(/\D/g, "");

    // si es @lid o viene raro, pedimos el contacto real
    if (isLid || digits.length < 8 || digits.length > 15) {
      const contact = await msg.getContact().catch(() => null);
      const cand = (contact?.number || contact?.id?.user || "").replace(/\D/g, "");
      if (cand) digits = cand;
    }

    return digits || null;
  } catch {
    return null;
  }
}

/* =========================
   HELPERS LANDINGS / CHAT START
   ========================= */
function codeFromSlug(slug) {
  if (!slug) return "";
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

// ✅ regex tolerante (con o sin acento) y NO depende de frase exacta
function extractLandingCodeFromMessage(body) {
  if (!body) return null;
  const s = String(body);
  const match = s.match(/c[oó]digo de descuento\s*es\s*:\s*([A-Z0-9_]+)/i);
  return match ? match[1].toUpperCase() : null;
}

const landingCodeCache = { loaded: false, byCode: new Map() };

async function loadLandingCodeCache() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("landing_pages").select("id, slug");
    if (error) {
      console.log("[WA-SERVER] Error cargando landing_pages:", error.message);
      return;
    }

    landingCodeCache.byCode.clear();
    (data || []).forEach((lp) => {
      if (!lp.slug) return;
      const code = codeFromSlug(lp.slug);
      landingCodeCache.byCode.set(code, { id: lp.id, slug: lp.slug });
    });

    landingCodeCache.loaded = true;
    console.log("[WA-SERVER] Cache landing codes cargada. Total:", landingCodeCache.byCode.size);
  } catch (e) {
    console.log("[WA-SERVER] Excepción loadLandingCodeCache:", e);
  }
}

async function findLandingByCode(code) {
  if (!supabase || !code) return null;

  if (!landingCodeCache.loaded) await loadLandingCodeCache();

  const upper = code.toUpperCase();
  if (landingCodeCache.byCode.has(upper)) return landingCodeCache.byCode.get(upper);

  await loadLandingCodeCache();
  return landingCodeCache.byCode.get(upper) || null;
}

async function trackChatStart({ landingId, waPhone, waLineId }) {
  try {
    const url = `${FRONTEND_BASE_URL}/api/landing-events`;
    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "chat",
        landingId,
        buttonId: null,
        waPhone: waPhone || null,
        waLineId: waLineId || null, // external_line_id (cmj...)
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[WA-SERVER] Error trackChatStart", res.status, text);
    } else {
      console.log("[WA-SERVER] trackChatStart OK ✅", { landingId, waPhone, waLineId });
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción trackChatStart:", e);
  }
}

/* =========================
   META CAPI: Purchase
   ========================= */
async function sendMetaPurchaseEvent({ landingId, waPhone, amount }) {
  try {
    if (!supabase) return;
    if (!landingId) return;

    const { data: landing, error } = await supabase
      .from("landing_pages")
      .select("id, meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .single();

    if (error || !landing) return;

    const pixelId = landing.meta_pixel_id;
    const accessToken = landing.meta_access_token;

    if (!pixelId || !accessToken) return;

    const normalizedPhone = (waPhone || "").replace(/\D/g, "");
    if (!normalizedPhone) return;

    const hashedPhone = crypto.createHash("sha256").update(normalizedPhone).digest("hex");

    const eventTime = Math.floor(Date.now() / 1000);
    const currency = process.env.META_DEFAULT_CURRENCY || "ARS";

    const body = {
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime,
          action_source: "website",
          user_data: { ph: [hashedPhone] },
          custom_data: { value: Number(amount) || 0, currency },
        },
      ],
    };

    if (process.env.META_TEST_EVENT_CODE) body.test_event_code = process.env.META_TEST_EVENT_CODE;

    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error("[META CAPI] Error HTTP:", res.status, txt);
    } else {
      console.log("[META CAPI] Purchase enviado OK ✅", { landingId, amount });
    }
  } catch (e) {
    console.error("[META CAPI] Excepción:", e);
  }
}

async function trackConversion({ landingId, waPhone, amount, screenshotUrl, waLineId }) {
  try {
    const url = `${FRONTEND_BASE_URL}/api/landing-events`;

    const res = await doFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "conversion",
        landingId,
        buttonId: null,
        waPhone: waPhone || null,
        waLineId: waLineId || null,
        amount,
        screenshotUrl: screenshotUrl || null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[WA-SERVER] Error trackConversion", res.status, text);
    } else {
      console.log("[WA-SERVER] trackConversion OK ✅", {
        landingId,
        waPhone,
        amount,
        screenshotUrl,
        waLineId,
      });
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción trackConversion:", e);
  }

  try {
    await sendMetaPurchaseEvent({ landingId, waPhone, amount });
  } catch {}
}

/* =========================
   ✅ FIX MULTIUSUARIO (clave del problema)
   - Vercel guarda landing_events.wa_line_id como UUID
   - Acá vos tenés lineId = external (cmj...)
   Entonces resolvemos UUID y además damos fallback a último CLICK
   ========================= */
function isUuid(v) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(v || "")
  );
}

async function resolveWaLineUuid(externalLineId) {
  if (!supabase || !externalLineId) return null;
  if (isUuid(externalLineId)) return String(externalLineId);

  try {
    const { data, error } = await supabase
      .from("wa_lines")
      .select("id")
      .eq("external_line_id", String(externalLineId))
      .maybeSingle();

    if (error) return null;
    return data?.id || null;
  } catch {
    return null;
  }
}

async function findRecentLandingForLine(lineUuid, minutes = 120) {
  if (!supabase || !lineUuid) return null;

  const since = new Date(Date.now() - minutes * 60 * 1000).toISOString();

  try {
    const { data, error } = await supabase
      .from("landing_events")
      .select("landing_id, created_at")
      .eq("wa_line_id", lineUuid)
      .eq("event_type", "click")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) return null;
    return data && data[0] ? data[0] : null;
  } catch {
    return null;
  }
}

const trackedChatStarts = new Set();

async function handleIncomingMessage(lineId, msg) {
  try {
    if (!msg || msg.fromMe) return;
    const from = msg.from || "";
    if (from.endsWith("@g.us")) return;

    const text = String(msg.body || msg.caption || "").trim();
    if (!text) return;

    const waPhone = await getRealPhoneFromMsg(msg);
    if (!waPhone) return;

    let landingId = null;

    // 1) Si viene el código, perfecto
    const code = extractLandingCodeFromMessage(text);
    if (code) {
      const landing = await findLandingByCode(code);
      landingId = landing?.id || null;
    }

    // 2) Si NO viene código: fallback a último CLICK de esa línea (2h)
    if (!landingId) {
      const lineUuid = await resolveWaLineUuid(lineId);
      const recent = await findRecentLandingForLine(lineUuid, 120);
      landingId = recent?.landing_id || null;
    }

    if (!landingId) return;

    const today = new Date().toISOString().slice(0, 10);
    const dedupeKey = `${lineId}_${landingId}_${waPhone}_${today}`;
    if (trackedChatStarts.has(dedupeKey)) return;

    trackedChatStarts.add(dedupeKey);

    console.log("[CHAT-START] attributed ✅", { lineId, waPhone, landingId });
    await trackChatStart({ landingId, waPhone, waLineId: lineId });
  } catch (e) {
    console.log("[WA-SERVER] Error handleIncomingMessage:", e?.message || e);
  }
}

/**
 * ✅ Atribución multiusuario:
 * 1) Busca último chat-start por (wa_line_id UUID + wa_phone)
 * 2) Si no hay, busca por (wa_phone) solo
 * 3) Si no hay chat-start, fallback a último CLICK por línea (2h)
 */
async function findLastLandingForPhone(lineId, waPhone) {
  if (!supabase || !waPhone) return null;

  const lineUuid = await resolveWaLineUuid(lineId);

  try {
    // 1) Mejor caso: chat por (lineUuid + phone)
    if (lineUuid) {
      let { data, error } = await supabase
        .from("landing_events")
        .select("landing_id, created_at")
        .eq("wa_line_id", lineUuid)
        .eq("wa_phone", waPhone)
        .eq("event_type", "chat")
        .order("created_at", { ascending: false })
        .limit(1);

      if (!error && data && data[0]) return data[0];
    }

    // 2) Fallback: chat por phone
    {
      const { data, error } = await supabase
        .from("landing_events")
        .select("landing_id, created_at")
        .eq("wa_phone", waPhone)
        .eq("event_type", "chat")
        .order("created_at", { ascending: false })
        .limit(1);

      if (!error && data && data[0]) return data[0];
    }

    // 3) Fallback final: último click por línea (2h)
    if (lineUuid) {
      const recent = await findRecentLandingForLine(lineUuid, 120);
      if (recent?.landing_id) return recent;
    }

    return null;
  } catch {
    return null;
  }
}

async function landingExists(landingId) {
  if (!supabase || !landingId) return false;
  try {
    const { data, error } = await supabase
      .from("landing_pages")
      .select("id")
      .eq("id", landingId)
      .maybeSingle();
    if (error) return false;
    return !!data?.id;
  } catch {
    return false;
  }
}

/**
 * ✅ MULTIUSUARIO: NO pisamos wa_phone en landing_pages por owner (te mezcla líneas).
 * Solo lo dejamos si vos configurás DEFAULT_* explícitamente.
 */
async function syncLandingPhone(lineId, phoneNumber, ownerId = null) {
  if (!supabase || !phoneNumber) return;

  // Solo si existe default explícito
  if (!DEFAULT_LANDING_ID && !DEFAULT_LANDING_SLUG) {
    return;
  }

  try {
    let query = supabase.from("landing_pages").update({ wa_phone: phoneNumber });

    if (DEFAULT_LANDING_ID) query = query.eq("id", DEFAULT_LANDING_ID);
    else if (DEFAULT_LANDING_SLUG) query = query.eq("slug", DEFAULT_LANDING_SLUG);

    const { data, error } = await query.select("id");

    if (error) console.log("[WA-SERVER] Error actualizando wa_phone:", error.message);
    else console.log("[WA-SERVER] wa_phone actualizado OK ✅", { updated: (data || []).length });
  } catch (e) {
    console.log("[WA-SERVER] Excepción syncLandingPhone:", e);
  }
}

/* =========================
   OCR HELPERS (tal cual + robusto)
   ========================= */
function parseAmountARS(raw) {
  if (!raw) return null;

  let s = String(raw)
    .replace(/\u00A0|\u202F/g, " ")
    .replace(/\s+/g, "")
    .replace(/[^0-9.,]/g, "");

  if (!s) return null;

  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts[parts.length - 1].length === 2)
      s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
    else s = parts.join("");
  } else if (s.includes(".")) {
    const parts = s.split(".");
    const last = parts[parts.length - 1];
    if (last.length === 3) s = parts.join("");
  }

  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function extractAmountFromText(text) {
  if (!text) return null;

  const norm = String(text).replace(/\r/g, "").replace(/\u00A0|\u202F/g, " ");

  const reCurrency = /\$\s*([0-9][0-9.,\s\u00A0\u202F]*)/g;
  let m;
  while ((m = reCurrency.exec(norm)) !== null) {
    const v = parseAmountARS(m[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  const reGrouped = /\b([1-9][0-9]{0,2}(?:[.,\s\u00A0\u202F][0-9]{3})+)(?:[.,]\d{1,2})?\b/g;
  while ((m = reGrouped.exec(norm)) !== null) {
    const v = parseAmountARS(m[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  return null;
}

async function ocrFromMedia({ base64, mimetype }) {
  try {
    const buf = Buffer.from(base64 || "", "base64");
    if (!buf.length) return "";

    if (mimetype === "application/pdf" || /\.pdf$/i.test(mimetype || "")) {
      try {
        const { text } = await pdfParse(buf);
        return (text || "").toString();
      } catch (e) {
        console.warn("[OCR] pdf-parse error:", e?.message || e);
        return "";
      }
    }

    let img = buf;
    if (sharp && /^image\/(jpe?g|png|webp)$/i.test(mimetype || "")) {
      try {
        img = await sharp(buf)
          .rotate()
          .resize({ width: 1600, withoutEnlargement: true })
          .grayscale()
          .normalize()
          .toFormat("png")
          .toBuffer();
      } catch (e) {
        console.warn("[OCR] sharp pipeline error:", e?.message || e);
      }
    }

    if (!Tesseract || typeof Tesseract.recognize !== "function") return "";

    const { data } = await Tesseract.recognize(img, "spa+eng", {
      tessedit_char_whitelist:
        "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz$.,:-/ ",
    });

    return data?.text || "";
  } catch (e) {
    console.warn("[OCR] error:", e?.message || e);
    return "";
  }
}

const NBSP = "\u00A0";
const NNSP = "\u202F";

function toNumberARS(raw) {
  if (raw == null) return null;

  const original = String(raw);

  let s = original
    .replace(/(?<=\d)[oO](?=\d)/g, "0")
    .replace(/[^\d.,\u00A0\u202F]/g, "")
    .replace(/\u00A0|\u202F/g, " ")
    .replace(/\s+/g, "")
    .replace(/^[.,]+|[.,]+$/g, "");

  if (!s) return null;

  const hasOcrTripleZero = /[.,](?:0{3}|0{2}[oO]|0[oO]0|[oO]0{2})(?!\d)/.test(original);

  if (s.includes(".")) {
    const parts = s.split(".");
    const last = parts[parts.length - 1];

    if (hasOcrTripleZero) {
      s = s.replace(/\./g, "");
      const v = parseFloat(s);
      return Number.isFinite(v) ? v : null;
    }

    if (/^0{3}$/.test(last) || last.length === 3) {
      s = s.replace(/\./g, "");
      const v = parseFloat(s);
      return Number.isFinite(v) ? v : null;
    }

    if (/^\d{1,3}(?:\.\d{3})+(?:\.\d{1,2})?$/.test(s)) {
      const dec = parts.pop();
      s = parts.join("") + "." + dec;
      const v = parseFloat(s);
      return Number.isFinite(v) ? v : null;
    }

    let v = parseFloat(s);
    if (Number.isFinite(v) && v < 1000 && /\.0{3,}\b/.test(original)) v *= 1000;
    return Number.isFinite(v) ? v : null;
  }

  if (s.includes(",")) {
    const looksThousandsComma = /^\d{1,3}(?:,\d{3})+(?:,\d{1,2})?$/.test(s);
    if (looksThousandsComma) {
      const parts = s.split(",");
      if (parts[parts.length - 1].length <= 2) {
        const dec = parts.pop();
        s = parts.join("") + "." + dec;
      } else {
        s = parts.join("");
      }
    } else {
      s = s.replace(/\./g, "").replace(",", ".");
    }
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : null;
  }

  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

function findBestAmount(text = "") {
  if (!text) return null;

  const norm = String(text)
    .replace(/\r/g, "")
    .replace(/[‘’´`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(new RegExp(`[${NBSP}${NNSP}]`, "g"), " ")
    .replace(/S\s*\$/gi, "$")
    .replace(/\bS\s*([0-9])/gi, "$$1")
    .replace(/\bARS\s*/gi, "$");

  const lines = norm
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const BAD_CTX =
    /(cuit|cuil|cvu|cbu|coelsa|operaci[oó]n|transacci[oó]n|identificaci[oó]n|c[oó]digo|n[uú]mero|referencia)/i;

  const KEY_NEAR =
    /(comprobante|transferencia|motivo|mercado\s*pago|pagaste|enviaste|de\b|para\b|monto|importe|total)/i;

  const toFloatFlexible = (raw) =>
    toNumberARS(String(raw).replace(new RegExp(`[${NBSP}${NNSP}]`, "g"), " ").trim());

  const candidates = [];
  const pushCand = (v, prio) => {
    if (Number.isFinite(v) && v >= 50 && v <= 10_000_000) candidates.push({ v, prio });
  };

  const RE_CURRENCY_ANY = /\$\s*([0-9][0-9.,\s\u00A0\u202F]*)/g;

  lines.forEach((line) => {
    if (!line || BAD_CTX.test(line) || !/\$/.test(line)) return;
    let m;
    while ((m = RE_CURRENCY_ANY.exec(line)) !== null) pushCand(toFloatFlexible(m[1]), 6);
  });

  const RE_GROUPED_OR_LONG =
    /\b([1-9][0-9]{0,2}(?:[.,\s\u00A0\u202F][0-9]{3})+|[1-9][0-9]{4,})(?:[.,]\d{1,2})?\b/g;

  if (candidates.length === 0) {
    lines.forEach((line, idx) => {
      if (!line || BAD_CTX.test(line)) return;
      let m;
      while ((m = RE_GROUPED_OR_LONG.exec(line)) !== null) {
        const raw = m[0];
        if (!/[.,\s\u00A0\u202F]/.test(raw)) {
          const asInt = parseInt(raw, 10);
          if (asInt >= 1900 && asInt <= 2099) continue;
        }

        const v = toFloatFlexible(raw);
        let bonus = 0;
        for (let k = Math.max(0, idx - 3); k <= Math.min(lines.length - 1, idx + 3); k++) {
          if (KEY_NEAR.test(lines[k])) {
            const dist = Math.abs(k - idx);
            bonus = Math.max(bonus, 3 - dist);
          }
        }
        pushCand(v, 2 + bonus);
      }
    });
  }

  if (candidates.length === 0) return null;

  const hasBig = candidates.some((c) => c.v >= 1000);
  const pool = hasBig ? candidates.filter((c) => c.v >= 1000) : candidates;
  pool.sort((a, b) => b.prio - a.prio || b.v - a.v);
  return pool[0] ? pool[0].v : null;
}

// (no es obligatorio para el flujo, pero lo dejo útil)
async function tryExtractAmountFromImage({ base64, mimetype }) {
  const text = await ocrFromMedia({ base64, mimetype });
  const scored = scoreReceiptText(text || "");
  return scored;
}

function scoreReceiptText(text = "") {
  const t = String(text || "");
  const lower = t.toLowerCase();

  const isMercadoPago = /mercado\s*pago|mp\s*mercado|mercadopago/.test(lower);
  const isTransfer = /transferencia|comprobante|enviaste|pagaste|importe|monto|total/.test(lower);

  const amount =
    findBestAmount(t) ??
    extractAmountFromText(t) ??
    null;

  let score = 0;
  if (isMercadoPago) score += 6;
  if (isTransfer) score += 3;
  if (amount && Number.isFinite(amount) && amount > 0) score += 5;

  const provider = isMercadoPago ? "Mercado Pago" : null;

  return { score, amount: amount ?? null, provider };
}

async function uploadReceiptToSupabase({ base64, mimetype, waPhone }) {
  if (!supabase) return null;

  try {
    const bucket = SUPABASE_BUCKET_RECEIPTS;
    const buffer = Buffer.from(base64 || "", "base64");
    if (!buffer.length) return null;

    let ext = "bin";
    if (/jpeg|jpg/i.test(mimetype)) ext = "jpg";
    else if (/png/i.test(mimetype)) ext = "png";
    else if (/webp/i.test(mimetype)) ext = "webp";
    else if (/pdf/i.test(mimetype)) ext = "pdf";

    const safePhone = waPhone || "unknown";
    const filePath = `${safePhone}/${Date.now()}.${ext}`;

    const { error: uploadError } = await supabase.storage.from(bucket).upload(filePath, buffer, {
      contentType: mimetype || "application/octet-stream",
      upsert: false,
    });

    if (uploadError) return null;

    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    return data?.publicUrl || null;
  } catch {
    return null;
  }
}

/* =========================
   CRM WEBHOOK (guardar msg)
   ========================= */
async function syncMessageToCrm(lineId, msg) {
  try {
    if (!CRM_WEBHOOK_URL) return;
    if (!msg || !msg.id) return;

    const phoneDigits = await getRealPhoneFromMsg(msg);
    if (!phoneDigits) return;

    const direction = msg.fromMe ? "out" : "in";

    const payload = {
      lineId,
      phone: phoneDigits,
      direction,
      waMessageId: msg.id?._serialized || String(msg.id),
      body: String(msg.body || msg.caption || ""),
      type: msg.type || "text",
      ts: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    };

    const res = await doFetch(CRM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[WA-SERVER] syncMessageToCrm error", res.status, text.slice(0, 300));
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción syncMessageToCrm:", e?.message || e);
  }
}

/* =========================
   COMPROBANTES (OCR -> conversion)
   ========================= */
const processedReceiptMsgIds = new Set();

async function handleReceiptMessage(lineId, msg) {
  try {
    if (!msg || msg.fromMe) return;
    const from = msg.from || "";

    if (!(from.endsWith("@c.us") || from.endsWith("@lid"))) return;

    const looksLikeMedia = msg.hasMedia === true || msg.type === "image" || msg.type === "document";
    if (!looksLikeMedia) return;

    const msgId = msg.id?._serialized || String(msg.id);
    if (processedReceiptMsgIds.has(msgId)) return;

    console.log("[RECEIPT] check", {
      lineId,
      from,
      type: msg.type,
      hasMedia: msg.hasMedia,
      id: msgId,
    });

    let media;
    try {
      media = await msg.downloadMedia();
    } catch {
      console.log("[RECEIPT] downloadMedia FAILED", { id: msgId });
      return;
    }

    if (!media || !media.data) {
      console.log("[RECEIPT] no media.data", { id: msgId });
      return;
    }

    const mimetype = media.mimetype || "";
    const isImage = /^image\/(jpeg|png|webp)$/i.test(mimetype);
    const isPdf = mimetype === "application/pdf";
    if (!isImage && !isPdf) {
      console.log("[RECEIPT] unsupported mimetype", { mimetype });
      return;
    }

    console.log("[RECEIPT] downloaded", {
      mimetype: media?.mimetype,
      filename: media?.filename,
      sizeB64: media?.data ? media.data.length : 0,
    });

    const caption = (msg.caption || msg.body || "").trim();
    const ocrText = await ocrFromMedia({ base64: media.data, mimetype });
    const combined = [caption, ocrText].filter(Boolean).join("\n");

    let { score, amount, provider } = scoreReceiptText(combined);
    const isMercadoPago = /mercado\s*pago/i.test(combined) || provider === "Mercado Pago";

    console.log("[RECEIPT] scored", { score, amount, provider, isMercadoPago });

    if (!Number.isFinite(amount) || amount <= 0 || score < 6) {
      console.log("[RECEIPT] rejected", { score, amount });
      return;
    }

    const waPhone = await getRealPhoneFromMsg(msg);
    if (!waPhone) return;

    // ✅ MULTIUSUARIO REAL: ahora sí resuelve UUID y tiene fallback a click
    let landing = await findLastLandingForPhone(lineId, waPhone);

    if (!landing || !landing.landing_id) {
      console.log("[RECEIPT] no landing attributed (no chat-start/click). skip.", { lineId, waPhone });
      return;
    }

    const okLanding = await landingExists(landing.landing_id);
    if (!okLanding) {
      console.log("[RECEIPT] landing_id not found in landing_pages. skip.", {
        landingId: landing.landing_id,
      });
      return;
    }

    const screenshotUrl = await uploadReceiptToSupabase({ base64: media.data, mimetype, waPhone });

    processedReceiptMsgIds.add(msgId);

    await trackConversion({
      landingId: landing.landing_id,
      waPhone,
      amount,
      screenshotUrl,
      waLineId: lineId,
    });
  } catch (e) {
    console.log("[WA-SERVER] Error handleReceiptMessage:", e?.message || e);
  }
}

/* =========================
   EXPRESS / WHATSAPP SETUP
   ========================= */
const app = express();
app.use(cors());
app.use(express.json({ limit: "25mb" }));

const PORT = process.env.WA_SERVER_PORT || 4002;

/**
 * sessions[lineId] = { client, status, qr, phoneNumber, connectedAt, cachedChats, cachedMessages, ownerId }
 */
const sessions = {};

const ACK_STATUS_MAP = {
  0: "pending",
  1: "sent",
  2: "delivered",
  3: "read",
  4: "read",
};

function createSession(lineId, ownerId = null) {
  const existing = sessions[lineId];
  if (existing && existing.client) {
    if (ownerId) existing.ownerId = ownerId;
    return existing;
  }

  console.log("[WA] Creando nueva sesión para línea", lineId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: lineId }),
    puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  const session = existing || {
    client: null,
    status: "connecting",
    qr: null,
    phoneNumber: null,
    connectedAt: null,
    cachedChats: [],
    cachedMessages: {},
    ownerId: ownerId || null,
  };

  if (ownerId) session.ownerId = ownerId;

  session.client = client;
  session.status = "connecting";
  session.qr = null;
  sessions[lineId] = session;

  client.on("qr", (qr) => {
    console.log("[WA] QR generado para línea", lineId);
    session.qr = qr;
    session.status = "qr";
  });

  client.on("ready", async () => {
    console.log("[WA] Cliente listo para línea", lineId);
    session.status = "connected";
    session.connectedAt = Date.now();

    try {
      const wid = client.info?.wid?._serialized || "";
      const phone = wid.split("@")[0] || null;
      session.phoneNumber = phone;

      // (multiusuario) NO pisamos landings por owner acá
      await syncLandingPhone(lineId, session.phoneNumber, session.ownerId);

      await upsertWaLine({
        lineId,
        phoneNumber: session.phoneNumber,
        status: "connected",
        ownerId: session.ownerId,
      });
    } catch (e) {
      console.log("[WA] Error ready()", e?.message || e);
    }
  });

  client.on("message", async (msg) => {
    try {
      const isMediaLike =
        msg?.hasMedia === true || ["image", "document", "audio", "ptt"].includes(msg?.type);
      if (isMediaLike) {
        console.log("[WA] Incoming media", {
          lineId,
          from: msg.from,
          type: msg.type,
          hasMedia: msg.hasMedia,
          id: msg.id?._serialized || String(msg.id),
          bodyLen: (msg.body || "").length,
        });
      }
    } catch {}

    await syncMessageToCrm(lineId, msg);
    await handleIncomingMessage(lineId, msg);
    await handleReceiptMessage(lineId, msg);
  });

  client.on("disconnected", (reason) => {
    console.log("[WA] Desconectado", lineId, reason);
    try {
      client.destroy();
    } catch {}
    session.status = "disconnected";
    session.client = null;
    session.qr = null;

    upsertWaLine({
      lineId,
      phoneNumber: session.phoneNumber,
      status: "disconnected",
      ownerId: session.ownerId,
    }).catch(() => {});
  });

  client.initialize();
  return session;
}

/* =========================
   HELPERS CHAT / PROFILEPIC
   ========================= */
function safeGetProfilePicUrl(client, chatId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!chatId || !client) return resolve(null);

    const timer = setTimeout(() => resolve(null), timeoutMs);

    client
      .getProfilePicUrl(chatId)
      .then((url) => {
        clearTimeout(timer);
        resolve(url || null);
      })
      .catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
  });
}

function isStatusChat(chat) {
  if (!chat || !chat.id) return false;
  if (chat.isStatus) return true;
  const serialized = chat.id._serialized || "";
  return (
    serialized === "status@broadcast" ||
    serialized.endsWith("@status") ||
    serialized.includes("status@broadcast")
  );
}

function normalizeChatId(chatId) {
  let targetId = chatId;
  if (!targetId.endsWith("@c.us") && !targetId.endsWith("@g.us")) {
    targetId = chatId.includes("@") ? chatId : `${chatId}@c.us`;
  }
  return targetId;
}

/* ============================================================
   ENDPOINTS SESIÓN
   ============================================================ */
app.post("/lines/:lineId/connect", (req, res) => {
  const { lineId } = req.params;
  if (!lineId) return res.status(400).json({ error: "lineId requerido" });

  const ownerId = req.body?.ownerId || null;

  const session = createSession(lineId, ownerId);
  return res.json({
    ok: true,
    status: session.status,
    qr: session.qr,
    phoneNumber: session.phoneNumber,
  });
});

app.get("/lines/:lineId/status", (req, res) => {
  const { lineId } = req.params;
  if (!lineId) return res.status(400).json({ error: "lineId requerido" });

  const session = sessions[lineId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  return res.json({ status: session.status, qr: session.qr, phoneNumber: session.phoneNumber });
});

app.post("/lines/:lineId/disconnect", async (req, res) => {
  const { lineId } = req.params;
  if (!lineId) return res.status(400).json({ error: "lineId requerido" });

  const session = sessions[lineId];
  if (!session) return res.status(404).json({ error: "Session not found" });

  try {
    if (session.client) {
      try {
        await session.client.logout();
      } catch {}
      try {
        await session.client.destroy();
      } catch {}
    }
    session.client = null;
    session.status = "disconnected";
    session.qr = null;
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Error al desconectar" });
  }
});

app.get("/lines/:lineId/qr", (req, res) => {
  const { lineId } = req.params;
  const session = sessions[lineId];
  if (!session || !session.qr) return res.json({ qr: null });
  return res.json({ qr: session.qr });
});

// --- el resto de endpoints (chats/messages/read/send) dejalos TAL CUAL ---
// (No hace falta tocarlos para multiusuario)

app.listen(PORT, () => {
  console.log(`[WA-SERVER] Listening on port ${PORT}`);
});
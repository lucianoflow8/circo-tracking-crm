// wa-server.js
// Servidor intermedio entre tu app Next y whatsapp-web.js

require("dotenv").config();  // 👈 SOLO ESTA, nada de dotenvx
const crypto = require("crypto"); // 👈 NUEVO: para hashear el teléfono (Meta CAPI)

const express = require("express");
const cors = require("cors");
const { Client, LocalAuth, MessageMedia } = require("whatsapp-web.js");
const { createClient } = require("@supabase/supabase-js");

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
  console.log(
    "[WA-SERVER] sharp no disponible (OCR sin preprocesado de imagen)"
  );
}

/* =========================
   CONFIG BÁSICA
   ========================= */

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL || "http://localhost:3000";

// 👇 Asegurate que diga "webhook" (con H)
const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL ||
  `${FRONTEND_BASE_URL}/api/whatsapp/webhook`;

/* =========================
   SUPABASE CONFIG
   ========================= */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY =
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

// opcionales: asociar el número a una landing concreta
const DEFAULT_LANDING_ID = process.env.DEFAULT_LANDING_ID || null;
const DEFAULT_LANDING_SLUG = process.env.DEFAULT_LANDING_SLUG || null;

// 👇 bucket donde se van a guardar los comprobantes
const SUPABASE_BUCKET_RECEIPTS =
  process.env.SUPABASE_BUCKET_RECEIPTS || "receipts";

let supabase = null;

if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log("[WA-SERVER] Supabase client inicializado");
} else {
  console.log(
    "[WA-SERVER] ATENCIÓN: faltan SUPABASE_URL o SUPABASE_SERVICE_KEY/SUPABASE_SERVICE_ROLE_KEY en .env, no se actualizará wa_phone ni se resolverán códigos de landing"
  );
}

/**
 * Guarda / actualiza info de la línea en la tabla wa_lines
 *
 * IMPORTANTE:
 * Esto asume que tu tabla wa_lines tiene, al menos:
 *   - id                 uuid (PK, default gen_random_uuid())
 *   - external_line_id   text UNIQUE
 *   - wa_phone           text (opcional)
 *   - status             text (opcional)
 *
 * Si llamaste distinto a external_line_id (ej: "external_id" o "wa_line_id"),
 * cambiá el nombre en el payload y en onConflict.
 */
// 👇 Guarda / actualiza info de la línea en la tabla wa_lines
async function upsertWaLine({ lineId, phoneNumber, status }) {
  if (!supabase) {
    console.log(
      "[WA-SERVER] Supabase no configurado, no se guarda wa_lines"
    );
    return;
  }
  if (!lineId) return;

  try {
    const payload = {
      external_line_id: String(lineId), // 👈 columna TEXT única en wa_lines
      wa_phone: phoneNumber || null,
      status: status || null,          // si no tenés columna status, podés borrar esta línea
    };

    const { data, error } = await supabase
      .from("wa_lines")
      .upsert(payload, {
        onConflict: "external_line_id", // índice único en wa_lines
      })
      .select("id, external_line_id, wa_phone")
      .single();

    if (error) {
      console.log("[WA-SERVER] Error upsert wa_lines:", error.message);
      return;
    }

    console.log("[WA-SERVER] wa_lines upsert OK →", data);
  } catch (e) {
    console.log("[WA-SERVER] Excepción upsert wa_lines:", e);
  }
}

/* =========================
   HELPERS PARA LANDINGS / CÓDIGO / CHAT
   ========================= */

// mismo criterio que en el front
function codeFromSlug(slug) {
  if (!slug) return "";
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

// extrae el código de un texto tipo:
// "... Mi código de descuento es: URUGUAY_PROMO"
function extractLandingCodeFromMessage(body) {
  if (!body) return null;
  const match = body.match(/Mi código de descuento es:\s*([A-Z0-9_]+)/i);
  return match ? match[1].toUpperCase() : null;
}

// cache muy simple (podrías mejorarlo a futuro)
const landingCodeCache = {
  loaded: false,
  byCode: new Map(), // code -> { id, slug }
};

// carga todas las landing y arma mapa código -> landing
async function loadLandingCodeCache() {
  if (!supabase) {
    console.log(
      "[WA-SERVER] Supabase no configurado, no se puede cargar landing_codes"
    );
    return;
  }
  try {
    const { data, error } = await supabase
      .from("landing_pages")
      .select("id, slug");

    if (error) {
      console.log(
        "[WA-SERVER] Error cargando landing_pages para códigos:",
        error.message
      );
      return;
    }

    landingCodeCache.byCode.clear();
    (data || []).forEach((lp) => {
      if (!lp.slug) return;
      const code = codeFromSlug(lp.slug);
      landingCodeCache.byCode.set(code, { id: lp.id, slug: lp.slug });
    });

    landingCodeCache.loaded = true;
    console.log(
      "[WA-SERVER] Cache de códigos de landing cargada. Total:",
      landingCodeCache.byCode.size
    );
  } catch (e) {
    console.log("[WA-SERVER] Excepción cargando landing_codes:", e);
  }
}

// busca landing a partir del código (URUGUAY_PROMO, etc.)
async function findLandingByCode(code) {
  if (!supabase) return null;
  if (!code) return null;

  if (!landingCodeCache.loaded) {
    await loadLandingCodeCache();
  }

  const upper = code.toUpperCase();
  if (landingCodeCache.byCode.has(upper)) {
    return landingCodeCache.byCode.get(upper);
  }

  // por si agregaste nuevas landings después de levantar el server:
  await loadLandingCodeCache();
  return landingCodeCache.byCode.get(upper) || null;
}

/**
 * POST a /api/landing-events con eventType=chat
 */
async function trackChatStart({ landingId, waPhone }) {
  try {
    const url = `${FRONTEND_BASE_URL}/api/landing-events`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "chat",
        landingId,
        buttonId: null,
        waPhone: waPhone || null,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[WA-SERVER] Error trackChatStart", res.status, text);
    } else {
      console.log(
        "[WA-SERVER] trackChatStart OK → landingId=",
        landingId,
        "waPhone=",
        waPhone
      );
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción trackChatStart:", e);
  }
}

/* =========================
   META CAPI: Purchase por landing
   ========================= */

/**
 * Envía un evento "Purchase" a Meta CAPI usando el pixel/token
 * configurado en la landing (landing_pages.meta_pixel_id / meta_access_token).
 *
 * landingId: uuid de landing_pages
 * waPhone: teléfono del jugador (string, ej: "54911...")
 * amount: monto del comprobante (number)
 */
async function sendMetaPurchaseEvent({ landingId, waPhone, amount }) {
  try {
    if (!supabase) {
      console.log(
        "[META CAPI] Supabase no configurado, no se puede resolver pixel/token"
      );
      return;
    }

    if (!landingId) {
      console.log("[META CAPI] Sin landingId, no se envía Purchase");
      return;
    }

    const { data: landing, error } = await supabase
      .from("landing_pages")
      .select("id, meta_pixel_id, meta_access_token")
      .eq("id", landingId)
      .single();

    if (error || !landing) {
      console.error(
        "[META CAPI] No se pudo leer landing_pages para Purchase:",
        error || "landing no encontrada"
      );
      return;
    }

    const pixelId = landing.meta_pixel_id;
    const accessToken = landing.meta_access_token;

    if (!pixelId || !accessToken) {
      console.warn(
        "[META CAPI] Landing sin meta_pixel_id o meta_access_token, no se envía Purchase. landingId=",
        landingId
      );
      return;
    }

    const normalizedPhone = (waPhone || "").replace(/\D/g, "");
    if (!normalizedPhone) {
      console.warn(
        "[META CAPI] Phone vacío o inválido, no se envía Purchase:",
        waPhone
      );
      return;
    }

    const hashedPhone = crypto
      .createHash("sha256")
      .update(normalizedPhone)
      .digest("hex");

    const eventTime = Math.floor(Date.now() / 1000);
    const currency = process.env.META_DEFAULT_CURRENCY || "ARS";

    const body = {
      data: [
        {
          event_name: "Purchase",
          event_time: eventTime,
          action_source: "website",
          user_data: {
            ph: [hashedPhone],
          },
          custom_data: {
            value: Number(amount) || 0,
            currency,
          },
        },
      ],
    };

    // Opcional: modo Test Events de Meta
    if (process.env.META_TEST_EVENT_CODE) {
      body.test_event_code = process.env.META_TEST_EVENT_CODE;
    }

    const url = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      console.error(
        "[META CAPI] Error HTTP al enviar Purchase:",
        res.status,
        txt
      );
    } else {
      console.log(
        "[META CAPI] Purchase enviado OK → landingId=",
        landingId,
        "phone=",
        normalizedPhone,
        "amount=",
        amount
      );
    }
  } catch (e) {
    console.error("[META CAPI] Excepción enviando Purchase:", e);
  }
}

/// POST a /api/landing-events con eventType=conversion
/// y además dispara un evento "Purchase" a Meta CAPI
async function trackConversion({ landingId, waPhone, amount, screenshotUrl }) {
  try {
    const url = `${FRONTEND_BASE_URL}/api/landing-events`;

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventType: "conversion",
        landingId,
        buttonId: null,
        waPhone: waPhone || null,
        amount,
        screenshotUrl: screenshotUrl || null, // 👈 también mandamos la URL del comprobante
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log("[WA-SERVER] Error trackConversion", res.status, text);
    } else {
      console.log(
        "[WA-SERVER] trackConversion OK → landingId=",
        landingId,
        "waPhone=",
        waPhone,
        "amount=",
        amount,
        "screenshotUrl=",
        screenshotUrl
      );
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción trackConversion:", e);
  }

  // 👇 Siempre intentamos mandar el Purchase a Meta también
  try {
    await sendMetaPurchaseEvent({ landingId, waPhone, amount });
  } catch (e) {
    console.log(
      "[WA-SERVER] Excepción adicional al enviar Purchase a Meta CAPI:",
      e
    );
  }
}

// para evitar duplicar "chat iniciado" muchas veces en el día
// key = `${lineId}_${landingId}_${waPhone}_${YYYY-MM-DD}`
const trackedChatStarts = new Set();

/**
 * Maneja mensajes entrantes para detectar "chat iniciado" por landing
 */
async function handleIncomingMessage(lineId, msg) {
  try {
    if (!msg) return;
    if (msg.fromMe) return; // sólo mensajes DEL cliente
    const from = msg.from || "";
    // ignorar grupos
    if (from.endsWith("@g.us")) return;

    const text = msg.body || "";
    if (!text) return;

    const code = extractLandingCodeFromMessage(text);
    if (!code) {
      // mensaje sin código → puede ser respuesta, no lo contamos
      return;
    }

    if (!supabase) {
      console.log(
        "[WA-SERVER] Supabase no configurado, no se puede resolver landing para código",
        code
      );
      return;
    }

    const landing = await findLandingByCode(code);
    if (!landing) {
      console.log("[WA-SERVER] No se encontró landing para código:", code);
      return;
    }

    const waPhone = from.split("@")[0] || null;
    if (!waPhone) return;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const dedupeKey = `${lineId}_${landing.id}_${waPhone}_${today}`;

    if (trackedChatStarts.has(dedupeKey)) {
      // ya contamos este chat hoy
      return;
    }

    trackedChatStarts.add(dedupeKey);
    await trackChatStart({ landingId: landing.id, waPhone });
  } catch (e) {
    console.log("[WA-SERVER] Error en handleIncomingMessage:", e);
  }
}

/**
 * Actualiza landing_pages.wa_phone con el número detectado
 */
async function syncLandingPhone(lineId, phoneNumber) {
  if (!supabase) {
    console.log("[WA-SERVER] Supabase no configurado, no se guarda wa_phone");
    return;
  }
  if (!phoneNumber) {
    console.log(
      "[WA-SERVER] No hay phoneNumber para guardar en wa_phone (línea:",
      lineId,
      ")"
    );
    return;
  }

  try {
    let query = supabase.from("landing_pages").update({ wa_phone: phoneNumber });

    if (DEFAULT_LANDING_ID) {
      query = query.eq("id", DEFAULT_LANDING_ID);
      console.log(
        `[WA-SERVER] Actualizando wa_phone por DEFAULT_LANDING_ID=${DEFAULT_LANDING_ID}`
      );
    } else if (DEFAULT_LANDING_SLUG) {
      query = query.eq("slug", DEFAULT_LANDING_SLUG);
      console.log(
        `[WA-SERVER] Actualizando wa_phone por DEFAULT_LANDING_SLUG=${DEFAULT_LANDING_SLUG}`
      );
    } else {
      query = query.is("wa_phone", null);
      console.log(
        "[WA-SERVER] Actualizando wa_phone en landing_pages donde wa_phone IS NULL"
      );
    }

    const { error } = await query;

    if (error) {
      console.log(
        "[WA-SERVER] Error actualizando wa_phone en Supabase:",
        error.message
      );
    } else {
      console.log("[WA-SERVER] wa_phone actualizado OK en landing_pages");
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción guardando wa_phone en Supabase:", e);
  }
}

/**
 * NUEVO: guarda/actualiza la línea en la tabla wa_lines
 * - id = lineId (el que usás en /lines/:lineId)
 * - wa_phone = número de WhatsApp detectado
 */
async function syncWaLine(lineId, phoneNumber) {
  if (!supabase) {
    console.log("[WA-SERVER] Supabase no configurado, no se guarda wa_lines");
    return;
  }
  if (!lineId || !phoneNumber) {
    console.log(
      "[WA-SERVER] Faltan lineId o phoneNumber para guardar en wa_lines"
    );
    return;
  }

  try {
    const payload = {
      id: lineId,
      wa_phone: phoneNumber,
      // label y owner_id los podés manejar después desde tu app
    };

    const { error } = await supabase
      .from("wa_lines")
      .upsert(payload, { onConflict: "id" });

    if (error) {
      console.log("[WA-SERVER] Error upsert wa_lines:", error.message);
    } else {
      console.log(
        "[WA-SERVER] wa_lines upsert OK → lineId=",
        lineId,
        "wa_phone=",
        phoneNumber
      );
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción guardando wa_lines:", e);
  }
}

/* =========================
   OCR HELPERS
   ========================= */

// ------- Helpers para monto ARS simple (fallback) -------
function parseAmountARS(raw) {
  if (!raw) return null;

  let s = String(raw)
    .replace(/\u00A0|\u202F/g, " ") // espacios raros
    .replace(/\s+/g, "") // sin espacios
    .replace(/[^0-9.,]/g, ""); // sólo dígitos y separadores

  if (!s) return null;

  // caso "20.000,50" -> "20000.50"
  if (s.includes(".") && s.includes(",")) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.includes(",")) {
    const parts = s.split(",");
    if (parts[parts.length - 1].length === 2) {
      // "10000,50" => decimales
      s = parts.slice(0, -1).join("") + "." + parts[parts.length - 1];
    } else {
      // "10,000" => miles
      s = parts.join("");
    }
  } else if (s.includes(".")) {
    const parts = s.split(".");
    const last = parts[parts.length - 1];
    // si el último bloque tiene 3 dígitos, lo tomo como separador de miles
    if (last.length === 3) {
      s = parts.join("");
    }
  }

  const num = Number(s);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

// Fallback viejito: busca un "$ 20.000" o "20.000" fuerte en el texto
function extractAmountFromText(text) {
  if (!text) return null;

  const norm = String(text).replace(/\r/g, "").replace(/\u00A0|\u202F/g, " ");

  // 1) con símbolo $
  const reCurrency = /\$\s*([0-9][0-9.,\s\u00A0\u202F]*)/g;
  let m;
  while ((m = reCurrency.exec(norm)) !== null) {
    const v = parseAmountARS(m[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  // 2) sin símbolo pero con miles (10.000, 20.000, etc)
  const reGrouped =
    /\b([1-9][0-9]{0,2}(?:[.,\s\u00A0\u202F][0-9]{3})+)(?:[.,]\d{1,2})?\b/g;

  while ((m = reGrouped.exec(norm)) !== null) {
    const v = parseAmountARS(m[1]);
    if (Number.isFinite(v) && v > 0) return v;
  }

  return null;
}

// Imagen/PDF -> texto con Tesseract
async function ocrFromMedia({ base64, mimetype }) {
  try {
    const buf = Buffer.from(base64 || "", "base64");
    if (!buf.length) return "";

    // PDF
    if (mimetype === "application/pdf" || /\.pdf$/i.test(mimetype || "")) {
      try {
        const { text } = await pdfParse(buf);
        return (text || "").toString();
      } catch (e) {
        console.warn("[OCR] pdf-parse error:", e?.message || e);
        return "";
      }
    }

    // Imagen
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

    if (!Tesseract || typeof Tesseract.recognize !== "function") {
      console.warn("[OCR] Tesseract.recognize no disponible");
      return "";
    }

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

// 🔧 Parser robusto de montos / FlowTracking-style
const NBSP = "\u00A0";
const NNSP = "\u202F";

// ⚙️ Regla global para MP x1000 (igual que FlowTracking)
const MP_FORCE_X1000 = (process.env.MP_FORCE_X1000 || "true") === "true";

function toNumberARS(raw) {
  if (raw == null) return null;

  const original = String(raw);

  let s = original
    .replace(/(?<=\d)[oO](?=\d)/g, "0") // 1O0 -> 100
    .replace(/[^\d.,\u00A0\u202F]/g, "")
    .replace(/\u00A0|\u202F/g, " ")
    .replace(/\s+/g, "")
    .replace(/^[.,]+|[.,]+$/g, "");

  if (!s) return null;

  const hasOcrTripleZero =
    /[.,](?:0{3}|0{2}[oO]|0[oO]0|[oO]0{2})(?!\d)/.test(original);

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

    if (Number.isFinite(v) && v < 1000 && /\.0{3,}\b/.test(original)) {
      v *= 1000;
    }
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

// Detecta patrones tipo "$ 3.000", "$ 5.000", "$ 150.000" en el texto
// y devuelve el "3", "5", "150" como número.
function hasMpThousandsPattern(text = "") {
  const norm = String(text)
    .replace(/\r/g, " ")
    .replace(/\s+/g, " ");

  const re = new RegExp(
    String.raw`\$?\s*([1-9]\d{0,5})[.\s,${NBSP}${NNSP}]0{3}(?!\d)`,
    "i"
  );

  const m = norm.match(re);
  if (!m) return null;

  const base = parseInt(m[1], 10);
  if (!Number.isFinite(base) || base <= 0) return null;

  return base;
}

// Detector de monto muy tolerante (texto completo)
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
    toNumberARS(
      String(raw)
        .replace(new RegExp(`[${NBSP}${NNSP}]`, "g"), " ")
        .trim()
    );

  const candidates = [];
  const pushCand = (v, prio) => {
    if (Number.isFinite(v) && v >= 50 && v <= 10_000_000) {
      candidates.push({ v, prio });
    }
  };

  const RE_CURRENCY_ANY = /\$\s*([0-9][0-9.,\s\u00A0\u202F]*)/g;

  lines.forEach((line) => {
    if (!line || BAD_CTX.test(line) || !/\$/.test(line)) return;

    let m;
    while ((m = RE_CURRENCY_ANY.exec(line)) !== null) {
      const v = toFloatFlexible(m[1]);
      pushCand(v, 6);
    }
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
        for (
          let k = Math.max(0, idx - 3);
          k <= Math.min(lines.length - 1, idx + 3);
          k++
        ) {
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

// 🔎 Fallback visual agresivo sólo imágenes (zona típica de MP)
async function tryExtractAmountFromImage({ base64, mimetype }) {
  if (!sharp) return null;
  if (!/^image\/(jpe?g|png|webp)$/i.test(mimetype || "")) return null;

  const buf = Buffer.from(base64 || "", "base64");
  let W = 1200,
    H = 1800;
  try {
    const meta = await sharp(buf).metadata();
    W = Math.max(1, meta.width || W);
    H = Math.max(1, meta.height || H);
  } catch {}

  const X0 = 0.04,
    X1 = 0.7;
  const Y0 = 0.08,
    Y1 = 0.48;

  const COLS = 4;
  const ROWS = 6;

  const startX = Math.floor(W * X0);
  const startY = Math.floor(H * Y0);
  const spanW = Math.max(1, Math.floor(W * (X1 - X0)));
  const spanH = Math.max(1, Math.floor(H * (Y1 - Y0)));

  const tileW = Math.max(1, Math.floor(spanW / COLS));
  const tileH = Math.max(1, Math.floor(spanH / ROWS));

  const padW = Math.floor(W * 0.08);
  const padH = Math.floor(H * 0.04);

  const NB = "\u00A0",
    NN = "\u202F";
  const RE_$AMT = new RegExp(
    String.raw`\$\s*([0-9][0-9.,\s${NB}${NN}]*)`
  );
  const RE_GROUP = new RegExp(
    String.raw`\b([1-9][0-9]{0,2}(?:[.\s${NB}${NNSP}][0-9]{3})+|[1-9][0-9]{4,})(?:[.,]\d{1,2})?\b`
  );
  const RE_TRIPLE_ZERO_HINT =
    /[.,](?:0{3}|0{2}[oO]|0[oO]0|[oO]0{2})(?!\d)/;

  const pipelines = [
    (i) => i.grayscale().normalize().linear(1.35, -18),
    (i) =>
      i
        .grayscale()
        .normalize()
        .median(1)
        .linear(1.5, -20)
        .threshold(150),
    (i) => i.grayscale().normalize().linear(1.8, -25).gamma(0.9),
  ];

  const readPiece = async (input) => {
    for (const psm of [6, 7]) {
      try {
        const { data } = await Tesseract.recognize(input, "spa+eng", {
          tessedit_char_whitelist: "0123456789$., ",
          tessedit_pageseg_mode: String(psm),
          preserve_interword_spaces: "1",
        });
        const raw = (data?.text || "").trim();
        if (!raw) continue;

        const hasTripleZero = RE_TRIPLE_ZERO_HINT.test(raw);

        let m = raw.match(RE_$AMT);
        if (m) {
          let v = toNumberARS(m[1]);
          if (Number.isFinite(v) && v < 1000 && hasTripleZero) v *= 1000;
          if (Number.isFinite(v) && v > 0) return v;
        }

        m = raw.match(RE_GROUP);
        if (m) {
          let v = toNumberARS(m[0]);
          if (Number.isFinite(v) && v < 1000 && hasTripleZero) v *= 1000;
          if (Number.isFinite(v) && v > 0) return v;
        }
      } catch {}
    }
    return null;
  };

  let best = null;

  for (let r = 0; r < ROWS && !best; r++) {
    for (let c = 0; c < COLS && !best; c++) {
      const baseLeft = startX + c * tileW;
      const baseTop = startY + r * tileH;

      const left = Math.max(0, baseLeft - Math.floor(padW / 2));
      const top = Math.max(0, baseTop - Math.floor(padH / 2));

      let width = Math.min(tileW + padW, W - left);
      let height = Math.min(tileH + padH, H - top);

      if (!Number.isFinite(width) || !Number.isFinite(height)) continue;
      width = Math.floor(width);
      height = Math.floor(height);
      if (width <= 16 || height <= 16) continue;

      try {
        const resized = await sharp(buf)
          .extract({ left, top, width, height })
          .resize({
            width: Math.max(600, width * 2),
            withoutEnlargement: false,
          })
          .toBuffer();

        for (const make of pipelines) {
          const png = await make(sharp(resized).clone())
            .toFormat("png")
            .toBuffer();
          const v = await readPiece(png);
          if (Number.isFinite(v) && v > 0) {
            best = best ? Math.max(best, v) : v;
            break;
          }
        }
      } catch {}
    }
  }
  return best;
}

// analiza texto y decide si parece comprobante + monto
function scoreReceiptText(text = "") {
  const t = (text || "").replace(/\s+/g, " ").trim();
  let score = 0;

  const hasComprobante = /comprobante/i.test(t);
  const hasTransfer = /transferencia/i.test(t);
  const hasMercadoPago = /mercado\s*pago/i.test(t);
  const hasKw =
    /pagaste|enviaste|pago realizado|n[uú]mero de operaci[oó]n|c[oó]digo de identificaci[oó]n/i.test(
      t
    );
  const hasBank =
    /(mercado\s*pago|ual[aá]|santander|galicia|macro|bbva|hsbc|icbc|naci[oó]n|bna|naranja\s*x|prex)/i.test(
      t
    );

  const amount = findBestAmount(text);
  const hasAmount = Number.isFinite(amount) && amount > 0;
  const hasId =
    /(operaci[oó]n|transacci[oó]n|c[oó]digo|identificaci[oó]n)\s*[:\-]?\s*[A-Z0-9\-]+/i.test(
      t
    );
  const parties =
    /(CUIT|CVU|CBU|\bcvu\b|\bcbu\b|beneficiario)/i.test(t);

  if (hasComprobante) score += 2;
  if (hasTransfer) score += 2;
  if (hasMercadoPago) score += 2;
  if (hasKw) score += 1;
  if (hasBank) score += 1;
  if (hasAmount) score += 3;
  if (hasId) score += 1;
  if (parties) score += 1;

  const hasCurrencySymbol = /\$/.test(t);
  const hasThousandsPattern = new RegExp(
    String.raw`\b[1-9]\d{0,2}(?:[.\s${NBSP}${NNSP}]\d{3})+(?:[,.\s]\d{1,2})?\b`
  ).test(t);

  if (hasCurrencySymbol) score += 1;
  if (hasThousandsPattern && Number.isFinite(amount) && amount >= 1000)
    score += 2;

  const provider = hasMercadoPago ? "Mercado Pago" : null;

  return { score, amount: hasAmount ? amount : null, provider };
}

// busca el último landing_id al que se le registró un chat para ese teléfono
async function findLastLandingForPhone(lineId, waPhone) {
  if (!supabase || !waPhone) return null;

  try {
    const { data, error } = await supabase
      .from("landing_events")
      .select("landing_id, created_at")
      .eq("wa_line_id", lineId)
      .eq("wa_phone", waPhone)
      .eq("event_type", "chat")
      .order("created_at", { ascending: false })
      .limit(1);

    if (error) {
      console.log(
        "[WA-SERVER] Error buscando último chat para conversion:",
        error.message
      );
      return null;
    }

    return data && data[0] ? data[0] : null;
  } catch (e) {
    console.log("[WA-SERVER] Excepción findLastLandingForPhone:", e);
    return null;
  }
}

async function uploadReceiptToSupabase({ base64, mimetype, waPhone }) {
  if (!supabase) {
    console.log("[WA-SERVER] Supabase no configurado, no subo comprobante");
    return null;
  }

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

    const { error: uploadError } = await supabase.storage
      .from(bucket)
      .upload(filePath, buffer, {
        contentType: mimetype || "application/octet-stream",
        upsert: false,
      });

    if (uploadError) {
      console.log(
        "[WA-SERVER] Error subiendo comprobante a Storage:",
        uploadError.message
      );
      return null;
    }

    const { data } = supabase.storage.from(bucket).getPublicUrl(filePath);
    const publicUrl = data?.publicUrl || null;

    console.log("[WA-SERVER] Comprobante subido OK →", publicUrl);

    return publicUrl;
  } catch (e) {
    console.log("[WA-SERVER] Excepción uploadReceiptToSupabase:", e);
    return null;
  }
}

/* =========================
   PERSISTENCIA CRM (WEBHOOK NEXT)
   ========================= */

/**
 * Envía cada mensaje al backend Next:
 *   POST /api/whatsapp/webhook
 * para que se guarde en la tabla CrmMessage (Prisma).
 */
async function syncMessageToCrm(lineId, msg) {
  try {
    if (!CRM_WEBHOOK_URL) {
      console.log("[WA-SERVER] CRM_WEBHOOK_URL no configurado, omito sync");
      return;
    }

    if (!msg || !msg.id) return;

    // Determinar teléfono y dirección
    // - Si el mensaje ES MÍO (fromMe = true) -> cliente está en msg.to
    // - Si el mensaje es DEL CLIENTE (fromMe = false) -> cliente está en msg.from
    const jid = msg.fromMe ? msg.to : msg.from;
    const rawPhone = (jid || "").split("@")[0];
    const phoneDigits = (rawPhone || "").replace(/\D/g, "");

    if (!phoneDigits) {
      console.log(
        "[WA-SERVER] syncMessageToCrm: no se pudo obtener phone para msg",
        msg.id?._serialized || String(msg.id)
      );
      return;
    }

    const direction = msg.fromMe ? "out" : "in";

    const payload = {
      lineId, // este es el external_line_id que usás en wa_lines
      phone: phoneDigits,
      direction,
      waMessageId: msg.id?._serialized || String(msg.id),
      body: msg.body || "",
      type: msg.type || "text",
      ts: msg.timestamp ? msg.timestamp * 1000 : Date.now(),
    };

    const res = await fetch(CRM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      console.log(
        "[WA-SERVER] syncMessageToCrm error",
        res.status,
        text.slice(0, 300)
      );
    } else {
      console.log("[WA-SERVER] Mensaje sync OK →", JSON.stringify(payload));
    }
  } catch (e) {
    console.log("[WA-SERVER] Excepción syncMessageToCrm:", e);
  }
}

// =========================
//  DE-DUPE COMPROBANTES + HANDLER
// =========================

// dedupe de comprobantes para no contar 2 veces el mismo mensaje
const processedReceiptMsgIds = new Set();

/**
 * Detecta comprobantes (imagen/PDF) → OCR → monto → trackConversion
 */
async function handleReceiptMessage(lineId, msg) {
  try {
    if (!msg) return;
    if (msg.fromMe) return; // el comprobante lo manda el cliente
    const from = msg.from || "";
    if (!from.endsWith("@c.us")) return; // ignorar grupos/broadcast

    const looksLikeMedia =
      msg.hasMedia === true ||
      msg.type === "image" ||
      msg.type === "document";
    if (!looksLikeMedia) return;

    const msgId = msg.id?._serialized || String(msg.id);
    if (processedReceiptMsgIds.has(msgId)) return;

    let media;
    try {
      media = await msg.downloadMedia();
    } catch (e) {
      console.log(
        "[WA-SERVER] downloadMedia error:",
        e?.message || e || "unknown"
      );
      return;
    }

    if (!media || !media.data) return;

    const mimetype = media.mimetype || "";
    const isImage = /^image\/(jpeg|png|webp)$/i.test(mimetype);
    const isPdf = mimetype === "application/pdf";
    if (!isImage && !isPdf) return;

    const caption = (msg.caption || msg.body || "").trim();
    const ocrText = await ocrFromMedia({
      base64: media.data,
      mimetype,
    });
    const combined = [caption, ocrText].filter(Boolean).join("\n");

    let { score, amount, provider } = scoreReceiptText(combined);
    console.log("[WA-SERVER] OCR resultado:", { score, amount, provider });

    const isMercadoPago =
      /mercado\s*pago/i.test(combined) || provider === "Mercado Pago";

    if (!Number.isFinite(amount) || amount <= 0) {
      const fallbackAmount = findBestAmount(combined);
      if (Number.isFinite(fallbackAmount) && fallbackAmount > 0) {
        amount = fallbackAmount;
        score = Math.max(score, 8);
        console.log(
          "[WA-SERVER] Monto detectado por fallback texto:",
          amount
        );
      } else {
        console.log(
          "[WA-SERVER] Fallback texto sin éxito, no se encontró monto"
        );
      }
    }

    const amountBeforeImage = amount;

    if (
      isMercadoPago &&
      isImage &&
      (!Number.isFinite(amountBeforeImage) || amountBeforeImage <= 0)
    ) {
      const mpImageAmount = await tryExtractAmountFromImage({
        base64: media.data,
        mimetype,
      });

      if (Number.isFinite(mpImageAmount) && mpImageAmount > 0) {
        let fixed = mpImageAmount;

        if (fixed < 1000 && MP_FORCE_X1000) {
          fixed = fixed * 1000;
          console.log(
            "[WA-SERVER] Heurística MP recorte x1000 aplicada →",
            fixed
          );
        }

        amount = fixed;
        score = Math.max(score, 9);
        console.log(
          "[WA-SERVER] Monto detectado por recorte de imagen MP:",
          amount
        );
      }
    }

    if (!Number.isFinite(amount) || amount <= 0 || score < 6) {
      console.log(
        "[WA-SERVER] Mensaje con media pero no parece comprobante, score:",
        score,
        "amount:",
        amount
      );
      return;
    }

    const waPhone = from.split("@")[0] || null;
    if (!waPhone) return;

    const landing = await findLastLandingForPhone(lineId, waPhone);
    if (!landing || !landing.landing_id) {
      console.log(
        "[WA-SERVER] No se encontró landing previa para este comprobante, no se trackea conversion"
      );
      return;
    }

    // Subimos el comprobante a Supabase Storage
    let screenshotUrl = null;
    try {
      screenshotUrl = await uploadReceiptToSupabase({
        base64: media.data,
        mimetype,
        waPhone,
      });
    } catch (e) {
      console.log("[WA-SERVER] No se pudo subir el comprobante:", e);
    }

    processedReceiptMsgIds.add(msgId);

    await trackConversion({
      landingId: landing.landing_id,
      waPhone,
      amount,
      screenshotUrl,
    });

    console.log(
      "[WA-SERVER] ✅ Conversion registrada → landingId=",
      landing.landing_id,
      "waPhone=",
      waPhone,
      "amount=",
      amount,
      "screenshotUrl=",
      screenshotUrl
    );
  } catch (e) {
    console.log("[WA-SERVER] Error en handleReceiptMessage:", e);
  }
}

/* =========================
   EXPRESS / WHATSAPP SETUP
   ========================= */

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.WA_SERVER_PORT || 4002;

/**
 * sessions[lineId] = {
 *   client,
 *   status,
 *   qr,
 *   phoneNumber,
 *   connectedAt,
 *   cachedChats: ChatSummary[],
 *   cachedMessages: { [chatId]: Message[] }
 * }
 */
const sessions = {};

const ACK_STATUS_MAP = {
  0: "pending",
  1: "sent",
  2: "delivered",
  3: "read",
  4: "read",
};

/**
 * Crea (o reutiliza) una sesión de WhatsApp para una línea
 */
function createSession(lineId) {
  let existing = sessions[lineId];

  if (existing && existing.client) {
    return existing;
  }

  console.log("[WA] Creando nueva sesión para línea", lineId);

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: lineId }),
    puppeteer: {
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    },
  });

  const session = existing || {
    qr: null,
    phoneNumber: null,
    connectedAt: null,
    cachedChats: [],
    cachedMessages: {},
  };

  session.client = client;
  session.status = "connecting";
  session.qr = null;

  sessions[lineId] = session;

  // QR
  client.on("qr", (qr) => {
    console.log("[WA] QR generado para línea", lineId);
    session.qr = qr;
    session.status = "qr";
  });

  // READY
  client.on("ready", async () => {
    console.log("[WA] Cliente listo para línea", lineId);
    session.status = "connected";
    session.connectedAt = Date.now();

    try {
      const wid = client.info?.wid?._serialized || ""; // ej: "54911...@c.us"
      const phone = wid.split("@")[0] || null;
      session.phoneNumber = phone;
      console.log(
        "[WA] Número detectado para línea",
        lineId,
        session.phoneNumber
      );

      // sigue funcionando igual para landing_pages
      await syncLandingPhone(lineId, session.phoneNumber);

      // 👇 NUEVO: guardamos / actualizamos wa_lines
      await upsertWaLine({
        lineId,
        phoneNumber: session.phoneNumber,
        status: "connected",
      });
    } catch (e) {
      console.log(
        "[WA] No se pudo leer/guardar el número de la línea",
        lineId,
        e
      );
    }
  });

  // MENSAJES (ENTRANTES Y SALIENTES)
  client.on("message", async (msg) => {
    await syncMessageToCrm(lineId, msg);   // 👈 logea SIEMPRE el mensaje
    await handleIncomingMessage(lineId, msg);
    await handleReceiptMessage(lineId, msg);
  });

  // DISCONNECTED
  client.on("disconnected", (reason) => {
    console.log("[WA] Desconectado", lineId, reason);
    try {
      client.destroy();
    } catch (e) {
      console.log("[WA] Error destruyendo cliente", e);
    }
    session.status = "disconnected";
    session.client = null;
    session.qr = null;

    // 👇 marcamos en wa_lines que esta línea se desconectó
    upsertWaLine({
      lineId,
      phoneNumber: session.phoneNumber,
      status: "disconnected",
    }).catch((e) => {
      console.log(
        "[WA-SERVER] Error upsert wa_lines al desconectar:",
        e
      );
    });
  });

  client.initialize();
  return session;
}

/* ============================================================
   MARCAR CHAT COMO LEÍDO
   ============================================================ */

app.post("/lines/:lineId/chats/:chatId/read", async (req, res) => {
  const { lineId, chatId } = req.params;
  console.log(
    "[WA-SERVER] POST /lines/:lineId/chats/:chatId/read",
    lineId,
    chatId
  );

  if (!lineId || !chatId) {
    return res.status(400).json({ error: "lineId y chatId requeridos" });
  }

  const session = sessions[lineId];
  if (!session || !session.client) {
    return res.status(404).json({
      error:
        "Session not found. Conectá la línea primero con /lines/:lineId/connect",
    });
  }

  try {
    const client = session.client;

    // Normalizar chatId → JID real (igual que en /messages)
    let targetId = chatId;
    if (!targetId.endsWith("@c.us") && !targetId.endsWith("@g.us")) {
      if (chatId.includes("@")) {
        targetId = chatId;
      } else {
        targetId = `${chatId}@c.us`;
      }
    }

    let chat = await client.getChatById(targetId).catch(() => null);

    // por si vino con @c.us y en realidad es grupo
    if (!chat && !targetId.endsWith("@g.us")) {
      const groupCandidate = targetId.replace(/@c\.us$/, "@g.us");
      chat = await client.getChatById(groupCandidate).catch(() => null);
      if (chat) {
        targetId = groupCandidate;
      }
    }

    if (!chat) {
      console.log("[WA-SERVER] Chat no encontrado para read()", targetId);
      return res.status(404).json({ error: "Chat no encontrado" });
    }

    // marcar como leído en WhatsApp
    try {
      if (typeof chat.sendSeen === "function") {
        await chat.sendSeen();
      } else if (typeof client.sendSeen === "function") {
        await client.sendSeen(targetId);
      }
    } catch (e) {
      console.log("[WA-SERVER] Error llamando sendSeen:", e);
    }

    // actualizar cache para que desaparezca el globo al próximo fetch
    if (Array.isArray(session.cachedChats)) {
      session.cachedChats = session.cachedChats.map((c) => {
        if (!c || !c.id) return c;
        if (c.id === chatId || c.id === targetId) {
          return { ...c, unreadCount: 0 };
        }
        return c;
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[WA-SERVER] Error marcando chat leído", err);
    return res
      .status(500)
      .json({ error: "Error al marcar el chat como leído" });
  }
});

/**
 * Helper seguro para obtener la foto de perfil con timeout
 */
function safeGetProfilePicUrl(client, chatId, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!chatId || !client) return resolve(null);

    const timer = setTimeout(() => {
      console.log("[WA] Timeout profilePic para chat", chatId);
      resolve(null);
    }, timeoutMs);

    client
      .getProfilePicUrl(chatId)
      .then((url) => {
        clearTimeout(timer);
        resolve(url || null);
      })
      .catch((err) => {
        clearTimeout(timer);
        console.log(
          "[WA] Error getProfilePicUrl para chat",
          chatId,
          err?.message
        );
        resolve(null);
      });
  });
}

function isStatusChat(chat) {
  if (!chat || !chat.id) return false;
  if (chat.isStatus) return true;
  const serialized = chat.id._serialized || "";
  if (serialized === "status@broadcast") return true;
  if (
    serialized.endsWith("@status") ||
    serialized.includes("status@broadcast")
  ) {
    return true;
  }
  return false;
}

/* ============================================================
   ENDPOINT CREAR GRUPOS
   ============================================================ */

app.post("/lines/:lineId/groups", async (req, res) => {
  const { lineId } = req.params;
  const {
    name,
    description,
    participants = [],
    messagesAdminsOnly = false,
    adminNumbers = [],
    avatar, // 👈 NUEVO
  } = req.body || {};

  console.log("[WA-SERVER] POST /lines/:lineId/groups", {
    lineId,
    name,
    description,
    participants,
    messagesAdminsOnly,
    adminNumbers,
    hasAvatar: !!avatar,
  });

  if (!lineId) {
    return res.status(400).json({ error: "lineId requerido" });
  }
  if (!name || !Array.isArray(participants) || participants.length === 0) {
    return res.status(400).json({
      error: "name y participants[] son requeridos",
    });
  }

  const session = sessions[lineId];
  if (!session || !session.client) {
    return res.status(404).json({
      error:
        "Session not found. Conectá la línea primero con /lines/:lineId/connect",
    });
  }

  try {
    const client = session.client;

    // participants pueden venir como "54911...@c.us" o solo número
    const participantIds = participants
      .map((p) => {
        if (typeof p !== "string") return null;
        if (p.endsWith("@c.us") || p.endsWith("@g.us")) return p;
        return `${p}@c.us`;
      })
      .filter(Boolean);

    console.log("[WA] Creando grupo con:", {
      name,
      participantIds,
    });

    const result = await client.createGroup(name, participantIds);
    const groupId = result?.gid?._serialized || result?.gid || null;

    if (!groupId) {
      console.log("[WA] No se pudo obtener groupId del createGroup", result);
      return res
        .status(500)
        .json({ error: "No se pudo obtener el id del grupo" });
    }

    const groupChat = await client.getChatById(groupId);

    // 👇 FORZAMOS el nombre del grupo para evitar que quede como número raro
    if (name && groupChat.setSubject) {
      try {
        await groupChat.setSubject(name);
      } catch (e) {
        console.log("[WA] Error seteando nombre (subject) del grupo", e);
      }
    }

    if (description && groupChat.setDescription) {
      try {
        await groupChat.setDescription(description);
      } catch (e) {
        console.log("[WA] Error seteando descripción del grupo", e);
      }
    }

    if (groupChat.setMessagesAdminsOnly) {
      try {
        await groupChat.setMessagesAdminsOnly(!!messagesAdminsOnly);
      } catch (e) {
        console.log("[WA] Error seteando mensajes solo admins", e);
      }
    }

    // 👉 Promover admins
    if (
      Array.isArray(adminNumbers) &&
      adminNumbers.length > 0 &&
      groupChat.promoteParticipants
    ) {
      try {
        const promoteIds = adminNumbers
          .map((n) => {
            if (typeof n !== "string") return null;
            if (n.endsWith("@c.us") || n.endsWith("@g.us")) return n;
            return `${n}@c.us`;
          })
          .filter(Boolean);

        if (promoteIds.length) {
          await groupChat.promoteParticipants(promoteIds);
        }
      } catch (e) {
        console.log("[WA] Error promoviendo admins del grupo", e);
      }
    }

    // 👉 FOTO DE PERFIL DEL GRUPO
    if (avatar && avatar.dataUrl) {
      try {
        const match = avatar.dataUrl.match(/^data:(.+?);base64,(.+)$/);
        if (match) {
          const mime = avatar.mimetype || match[1] || "image/jpeg";
          const base64 = match[2];
          const fileName = avatar.fileName || "group.jpg";

          const media = new MessageMedia(mime, base64, fileName);

          if (groupChat.setPicture) {
            await groupChat.setPicture(media);
          } else if (groupChat.setIcon) {
            // por si tu versión de whatsapp-web.js usa este método
            await groupChat.setIcon(media);
          } else {
            console.log(
              "[WA] groupChat no tiene setPicture/setIcon; no se pudo poner la foto"
            );
          }
        } else {
          console.log(
            "[WA] avatar.dataUrl sin formato data:mime;base64,..."
          );
        }
      } catch (e) {
        console.log("[WA] Error seteando foto del grupo", e);
      }
    }

    return res.json({
      ok: true,
      groupId,
      // usamos el nombre de WhatsApp, pero si por algo viene vacío usamos el que pasaste
      name: groupChat.name || name,
      description: description || null,
      messagesAdminsOnly: !!messagesAdminsOnly,
    });
  } catch (err) {
    console.error("[WA-SERVER] Error al crear grupo", err);
    return res
      .status(500)
      .json({ error: "Error al crear el grupo de WhatsApp" });
  }
});

/* ============================================================
   ENDPOINTS BÁSICOS DE SESIÓN
   ============================================================ */

app.post("/lines/:lineId/connect", (req, res) => {
  const { lineId } = req.params;
  if (!lineId) {
    return res.status(400).json({ error: "lineId requerido" });
  }

  const session = createSession(lineId);

  return res.json({
    ok: true,
    status: session.status,
    qr: session.qr,
    phoneNumber: session.phoneNumber,
  });
});

app.get("/lines/:lineId/status", (req, res) => {
  const { lineId } = req.params;
  console.log("[WA-SERVER] GET /lines/:lineId/status", lineId);

  if (!lineId) {
    return res.status(400).json({ error: "lineId requerido" });
  }

  const session = sessions[lineId];
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  return res.json({
    status: session.status,
    qr: session.qr,
    phoneNumber: session.phoneNumber,
  });
});

app.post("/lines/:lineId/disconnect", async (req, res) => {
  const { lineId } = req.params;
  console.log("[WA-SERVER] POST /lines/:lineId/disconnect", lineId);

  if (!lineId) {
    return res.status(400).json({ error: "lineId requerido" });
  }

  const session = sessions[lineId];
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  try {
    if (session.client) {
      try {
        await session.client.logout();
      } catch (e) {
        console.log("[WA] Error en logout (ya estaba off?):", e);
      }

      try {
        await session.client.destroy();
      } catch (e) {
        console.log("[WA] Error destruyendo cliente:", e);
      }
    }

    session.client = null;
    session.status = "disconnected";
    session.qr = null;

    return res.json({ ok: true });
  } catch (err) {
    console.error("[WA-SERVER] Error al desconectar línea", lineId, err);
    return res
      .status(500)
      .json({ error: "Error al desconectar la sesión de WhatsApp" });
  }
});

app.get("/lines/:lineId/qr", (req, res) => {
  const { lineId } = req.params;

  const session = sessions[lineId];
  if (!session || !session.qr) {
    return res.json({ qr: null });
  }

  return res.json({ qr: session.qr });
});

/* ============================================================
   LISTA DE CHATS
   ============================================================ */

app.get("/lines/:lineId/chats", async (req, res) => {
  const { lineId } = req.params;
  console.log("[WA-SERVER] GET /lines/:lineId/chats", lineId);

  const session = sessions[lineId];
  if (!session) {
    return res.status(404).json({ error: "Session not found" });
  }

  if (!session.client) {
    console.log("[WA-SERVER] Línea sin client, devolviendo chats cacheados");
    return res.json({ chats: session.cachedChats || [] });
  }

  try {
    const chats = await session.client.getChats();
    const connectedAt = session.connectedAt || Date.now();

    const freshFromWa = await Promise.all(
      chats
        .filter((c) => !isStatusChat(c))
        .map(async (c) => {
          const lastMsg = c.lastMessage;
          let lastMessageAt = null;
          let lastTimestampMs = 0;
          let lastMessageFromMe = false;
          let lastMessageStatus = null;

          if (lastMsg) {
            if (lastMsg.timestamp) {
              lastTimestampMs = lastMsg.timestamp * 1000;
              lastMessageAt = new Date(lastTimestampMs).toISOString();
            }

            lastMessageFromMe = !!lastMsg.fromMe;
            if (lastMsg.fromMe) {
              lastMessageStatus = ACK_STATUS_MAP[lastMsg.ack] || "sent";
            }
          }

          // ignorar chats viejos de antes de conectar
          if (!lastTimestampMs || lastTimestampMs < connectedAt) {
            return null;
          }

          const serializedId = c.id?._serialized;

          // 👉 nombre distinto para grupos vs individuales
          const summaryName = (() => {
            if (c.isGroup) {
              // GRUPOS: nunca mostrar el número como nombre
              return (
                c.name ||
                (c.groupMetadata && c.groupMetadata.subject) ||
                c.formattedTitle ||
                "Grupo sin nombre"
              );
            }

            // INDIVIDUALES
            return (
              c.name ||
              c.pushname ||
              c.formattedTitle ||
              (c.contact &&
                (c.contact.name ||
                  c.contact.pushname ||
                  c.contact.shortName)) ||
              c.id?.user ||
              "Sin nombre"
            );
          })();

          const summary = {
            id: serializedId,
            waChatId: serializedId,
            name: summaryName,
            isGroup: !!c.isGroup,
            lastMessage: lastMsg ? lastMsg.body : "",
            lastMessageAt,
            lastTimestampMs,
            unreadCount: c.unreadCount || 0,
            lastMessageFromMe,
            lastMessageStatus,
          };

          const profilePicUrl = await safeGetProfilePicUrl(
            session.client,
            serializedId
          );

          return { ...summary, profilePicUrl };
        })
    );

    const filteredFresh = freshFromWa.filter(Boolean);

    // 🔥 Merge cache + datos frescos SIN revivir el unreadCount si ya lo pusimos en 0
    const prev = Array.isArray(session.cachedChats)
      ? [...session.cachedChats]
      : [];

    const byId = new Map();

    // 1) Primero lo que ya había en cache
    for (const c of prev) {
      if (!c || !c.id) continue;
      byId.set(c.id, c);
    }

    // 2) Ahora mergeamos con lo fresco de WA
    for (const c of filteredFresh) {
      if (!c || !c.id) continue;

      const prevChat = byId.get(c.id);
      if (prevChat) {
        const merged = { ...prevChat, ...c };

        // 👇 Si ya habíamos dejado unreadCount=0 y WA sigue mandando 1
        // pero el último mensaje es el mismo, conservamos el 0.
        if (
          typeof prevChat.unreadCount === "number" &&
          prevChat.unreadCount === 0 &&
          typeof c.unreadCount === "number" &&
          c.unreadCount > 0 &&
          prevChat.lastTimestampMs === c.lastTimestampMs // 👉 no hay mensaje nuevo
        ) {
          merged.unreadCount = 0;
        }

        byId.set(c.id, merged);
      } else {
        byId.set(c.id, c);
      }
    }

    // más nuevos arriba
    const merged = Array.from(byId.values()).sort(
      (a, b) => (b.lastTimestampMs || 0) - (a.lastTimestampMs || 0)
    );

    session.cachedChats = merged;

    return res.json({ chats: merged });
  } catch (err) {
    console.error("[WA-SERVER] Error al obtener chats", err);
    if (session.cachedChats && session.cachedChats.length) {
      return res.json({ chats: session.cachedChats });
    }
    return res.status(500).json({ error: "Error al obtener chats" });
  }
});

/* ============================================================
   ENVIAR MENSAJE A UN CHAT
   ============================================================ */

app.post("/lines/:lineId/chats/:chatId/messages", async (req, res) => {
  const { lineId, chatId } = req.params;
  const { body, type, media } = req.body || {};

  console.log(
    "[WA-SERVER] POST /lines/:lineId/chats/:chatId/messages",
    lineId,
    chatId,
    { type }
  );

  if (!lineId || !chatId) {
    return res
      .status(400)
      .json({ error: "lineId y chatId son requeridos para enviar mensaje" });
  }

  if (!body && !media) {
    return res
      .status(400)
      .json({ error: "Falta body o media para enviar el mensaje" });
  }

  const session = sessions[lineId];
  if (!session || !session.client) {
    return res.status(404).json({
      error:
        "Session not found. Conectá la línea primero con /lines/:lineId/connect",
    });
  }

  const client = session.client;

  try {
    // 🔧 Normalizar chatId → JID real
    let targetId = chatId;
    if (!targetId.endsWith("@c.us") && !targetId.endsWith("@g.us")) {
      if (chatId.includes("@")) {
        targetId = chatId;
      } else {
        targetId = `${chatId}@c.us`;
      }
    }

    let chat = await client.getChatById(targetId).catch(() => null);

    // Por si es grupo y vino como número
    if (!chat && !targetId.endsWith("@g.us")) {
      const groupCandidate = targetId.replace(/@c\.us$/, "@g.us");
      chat = await client.getChatById(groupCandidate).catch(() => null);
      if (chat) targetId = groupCandidate;
    }

    if (!chat) {
      console.log("[WA-SERVER] Chat no encontrado al enviar mensaje", targetId);
      return res.status(404).json({ error: "Chat no encontrado" });
    }

    // ==========================================
    //  ARMAR MENSAJE SEGÚN type / media
    // ==========================================
    let sentMessage;

    // Si viene media desde el front
    if (media && media.dataUrl) {
      try {
        const match = media.dataUrl.match(/^data:(.+?);base64,(.+)$/);
        if (!match) {
          return res.status(400).json({
            error:
              "Formato de media.dataUrl inválido. Esperado data:mime;base64,....",
          });
        }

        const mimetype =
          media.mimetype || match[1] || "application/octet-stream";
        const base64 = match[2];
        const fileName =
          media.fileName ||
          (type === "image"
            ? "image.jpg"
            : type === "audio"
            ? "audio.ogg"
            : "file.bin");

        const messageMedia = new MessageMedia(mimetype, base64, fileName);

        // Imagen con o sin caption
        if (type === "image") {
          sentMessage = await client.sendMessage(targetId, messageMedia, {
            caption: body || "",
          });
        }
        // Documento / PDF
        else if (type === "document") {
          sentMessage = await client.sendMessage(targetId, messageMedia, {
            caption: body || "",
          });
        }
        // Audio / PTT
        else if (type === "audio") {
          sentMessage = await client.sendMessage(targetId, messageMedia, {});
        }
        // Genérico media
        else {
          sentMessage = await client.sendMessage(targetId, messageMedia, {
            caption: body || "",
          });
        }
      } catch (e) {
        console.log("[WA-SERVER] Error preparando/enviando media:", e);
        return res
          .status(500)
          .json({ error: "No se pudo enviar el media por WhatsApp" });
      }
    } else {
      // Mensaje SOLO texto
      sentMessage = await client.sendMessage(targetId, body || "");
    }

    if (!sentMessage) {
      return res
        .status(500)
        .json({ error: "WhatsApp no devolvió mensaje enviado" });
    }

    // ==========================================
    //  LOGEAR EN CRM
    // ==========================================
    try {
      await syncMessageToCrm(lineId, sentMessage);
    } catch (e) {
      console.log("[WA-SERVER] Error syncMessageToCrm al enviar:", e);
    }

    // ==========================================
    //  MAPEAR A FORMATO DEL FRONT
    // ==========================================
    const tsMs = sentMessage.timestamp
      ? sentMessage.timestamp * 1000
      : Date.now();

    let finalType = "text";
    let mediaPayload = null;

    if (sentMessage.hasMedia) {
      // Ojo: cuando recién se envía, a veces todavía no baja el blob,
      // pero el front ya sabe qué mandó, así que podemos usar "type" del body
      finalType =
        type ||
        (sentMessage.type === "image"
          ? "image"
          : sentMessage.type === "audio" || sentMessage.type === "ptt"
          ? "audio"
          : sentMessage.type === "document"
          ? "document"
          : "media");
    } else {
      finalType = type || "text";
    }

    const mapped = {
      id: sentMessage.id?._serialized || String(sentMessage.id),
      fromMe: true,
      body: sentMessage.body || body || "",
      timestamp: new Date(tsMs).toISOString(),
      status: ACK_STATUS_MAP[sentMessage.ack] || "sent",
      senderName: null,
      senderNumber: null,
      senderAvatar: null,
      type: finalType,
      media: mediaPayload,
    };

    // ==========================================
    //  ACTUALIZAR CACHE DE MENSAJES
    // ==========================================
    if (!session.cachedMessages) session.cachedMessages = {};

    const cacheKey = targetId;
    const prev = Array.isArray(session.cachedMessages[cacheKey])
      ? [...session.cachedMessages[cacheKey]]
      : [];

    const byId = new Map();
    for (const msg of prev) byId.set(msg.id, msg);
    byId.set(mapped.id, mapped);

    const merged = Array.from(byId.values()).sort(
      (a, b) => new Date(a.timestamp) - new Date(b.timestamp)
    );

    session.cachedMessages[cacheKey] = merged;

    // ==========================================
    //  ACTUALIZAR CACHE DE CHATS
    // ==========================================
    if (Array.isArray(session.cachedChats)) {
      let found = false;

      session.cachedChats = session.cachedChats.map((c) => {
        if (!c || !c.id) return c;

        if (c.id === targetId || c.id === chatId) {
          found = true;
          return {
            ...c,
            lastMessage: mapped.body,
            lastMessageAt: mapped.timestamp,
            lastTimestampMs: tsMs,
            lastMessageFromMe: true,
            lastMessageStatus: mapped.status,
            // como lo acabás de mandar vos, unreadCount = 0
            unreadCount: 0,
          };
        }
        return c;
      });

      // Si por alguna razón el chat no estaba en cache, podrías
      // agregarlo acá en el futuro.
      if (!found) {
        console.log(
          "[WA-SERVER] Aviso: el chat no estaba en cachedChats al enviar mensaje"
        );
      }
    }

    return res.json({ ok: true, message: mapped });
  } catch (err) {
    console.error("[WA-SERVER] Error al enviar mensaje", err);
    return res
      .status(500)
      .json({ error: "Error interno al enviar el mensaje" });
  }
});

/* ============================================================
   FIN
   ============================================================ */

app.listen(PORT, () => {
  console.log(`[WA-SERVER] Listening on port ${PORT}`);
});
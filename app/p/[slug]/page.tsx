// app/p/[slug]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Script from "next/script"; // 👈 Pixel
import { supabase } from "@/lib/supabaseClient";

/* ================== TYPES ================== */

type GameIcon = {
  id: string;
  url: string;
  size?: number; // escala 0.5 – 1.5
};

type FloatingText = {
  id: string;
  text: string;
  x: number; // %
  y: number; // %
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number;
  fontWeight: "normal" | "bold";
};

type LandingButton = {
  id: string;
  label: string;
  x: number; // %
  y: number; // %
};

type LandingContent = {
  bgImageUrl?: string;
  blurBg?: boolean;
  logoUrl?: string;

  title?: string;
  subtitle?: string;

  // Posiciones (en porcentaje) del bloque principal y el logo
  titleX?: number;
  titleY?: number;
  logoX?: number;
  logoY?: number;

  // Compatibilidad vieja
  buttonText?: string;
  buttonBgColor?: string;
  buttonTextColor?: string;

  // Nuevo modelo de botones
  buttons?: LandingButton[];

  gameIcons?: GameIcon[];

  // Textos flotantes
  floatingTexts?: FloatingText[];
};

type LandingRow = {
  id: string;
  slug: string;
  wa_message: string | null;
  wa_phone: string | null; // backup
  content: LandingContent | null;

  // 👇 pixel
  meta_pixel_id?: string | null;
  meta_access_token?: string | null;
};

type WaRoutingInfo = {
  ok: boolean;
  lineId?: string;
  waPhone?: string;
  waLink?: string;
  ownerId?: string | null;
};

/* ================== DEFAULT CONTENT ================== */

const defaultContent: LandingContent = {
  bgImageUrl: "",
  blurBg: true,
  logoUrl: "",
  title: "RECLAMÁ TU BONO DE 30% EXTRA",
  subtitle: "Landing simple para tus campañas de Meta",

  // Centro por defecto
  titleX: 50,
  titleY: 35,
  logoX: 50,
  logoY: 22,

  buttonText: "Ir al WhatsApp ahora",
  buttonBgColor: "#22d3ee",
  buttonTextColor: "#000000",

  buttons: [
    {
      id: "btn_1",
      label: "Ir al WhatsApp ahora",
      x: 50,
      y: 65,
    },
  ],

  gameIcons: [],
  floatingTexts: [],
};

/* Helper para código de landing basado en slug */
function getLandingCodeFromSlug(slug: string) {
  return slug.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

export default function PublicLandingPage() {
  const params = useParams();
  const slug = (params?.slug as string) || "";

  const [row, setRow] = useState<LandingRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // loading del click (mientras pedimos el número rotado)
  const [loadingWa, setLoadingWa] = useState(false);

  /* ---------- LOAD LANDING (Supabase) ---------- */
  useEffect(() => {
    if (!slug) return;

    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const { data, error } = await supabase
          .from("landing_pages")
          .select(
            "id, slug, wa_message, wa_phone, content, meta_pixel_id, meta_access_token"
          )
          .eq("slug", slug)
          .single();

        if (error) throw error;
        setRow(data as LandingRow);
      } catch (e: any) {
        console.error(e);
        setError(e.message ?? "No se pudo cargar la landing.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [slug]);

  /* ---------- MENSAJE DE WHATSAPP ---------- */

  const baseMessage = row?.wa_message || "Quiero aprovechar la promo 👋";

  const landingCode = row?.slug ? getLandingCodeFromSlug(row.slug) : "";

  const waMessage = landingCode
    ? `${baseMessage}. Mi código de descuento es: ${landingCode}`
    : baseMessage;

  /* ---------- CONFIG BÁSICA ---------- */

  const content: LandingContent = {
    ...defaultContent,
    ...(row?.content || {}),
  };

  // Compatibilidad: si no hay "buttons" pero sí buttonText viejo, creo uno
  if (!content.buttons || content.buttons.length === 0) {
    content.buttons = [
      {
        id: "btn_1",
        label: content.buttonText || defaultContent.buttonText!,
        x: 50,
        y: 65,
      },
    ];
  }

  const gameIcons: GameIcon[] = content.gameIcons || [];
  const floatingTexts: FloatingText[] = content.floatingTexts || [];
  const buttons: LandingButton[] = content.buttons || [];

  const buttonTextColor = content.buttonTextColor || "#000000";

  /* ============ TRACKING (visita + clicks) ============ */

  const trackEvent = async (
    eventType: "visit" | "click" | "chat",
    extra?: { buttonId?: string; waLineId?: string | null }
  ) => {
    try {
      await fetch("/api/landing-events", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          eventType,
          landingId: row?.id ?? null,
          buttonId: extra?.buttonId ?? null,

          // IMPORTANTE:
          // waPhone es del LEAD (jugador) => en visit/click mandamos null.
          waPhone: null,

          // Para click guardamos qué línea se asignó
          waLineId: extra?.waLineId ?? null,
        }),
      });
    } catch (e) {
      console.error("Error enviando evento", e);
    }
  };

  // Track visita al cargar la landing (NO rota líneas)
  useEffect(() => {
    if (!row?.id) return;
    trackEvent("visit");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  /* ---------- CLICK: ROTACIÓN POR CLICK ---------- */

  const handleWhatsAppClick = async (buttonId: string) => {
    if (!row?.id && !row?.slug) return;

    try {
      setLoadingWa(true);

      const params = new URLSearchParams();
      if (row?.id) params.set("landingId", row.id);
      else if (row?.slug) params.set("slug", row.slug);
      if (waMessage) params.set("text", waMessage);

      const res = await fetch(`/api/landing-wa-phone?${params.toString()}`, {
        method: "GET",
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.error("[Landing] Error landing-wa-phone:", data);

        // fallback al wa_phone fijo si existiera
        const fallbackPhone = row?.wa_phone || "";
        const fallbackUrl = fallbackPhone
          ? `https://wa.me/${fallbackPhone}?text=${encodeURIComponent(waMessage)}`
          : `https://wa.me/?text=${encodeURIComponent(waMessage)}`;

        // igual trackeamos click (sin waLineId)
        await trackEvent("click", { buttonId, waLineId: null });

        window.location.href = fallbackUrl;
        return;
      }

      const data: WaRoutingInfo = await res.json();

      // track click con la línea asignada (external_line_id)
      await trackEvent("click", { buttonId, waLineId: data.lineId ?? null });

      // redirigir al link ya armado por el backend
      if (data.ok && data.waLink) {
        window.location.href = data.waLink;
        return;
      }

      // fallback extra (si vino phone pero no waLink)
      if (data.ok && data.waPhone) {
        window.location.href = `https://wa.me/${data.waPhone}?text=${encodeURIComponent(
          waMessage
        )}`;
        return;
      }

      console.error("[Landing] landing-wa-phone devolvió ok=false", data);
    } catch (e) {
      console.error("[Landing] Excepción click WA:", e);
    } finally {
      setLoadingWa(false);
    }
  };

  /* ================== RENDER ================== */

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-black text-white">
        <p className="text-sm text-white/70">Cargando landing…</p>
      </main>
    );
  }

  if (error || !row) {
    return (
      <main className="min-h-screen flex items-center justify-center bg-black text-white">
        <div className="text-center px-4">
          <h1 className="text-2xl font-semibold mb-2">404</h1>
          <p className="text-sm text-white/70">Landing no encontrada.</p>
        </div>
      </main>
    );
  }

  return (
    <>
      <main className="min-h-screen bg-[#050816] text-white">
        <div className="relative min-h-screen overflow-hidden">
          {/* Fondo */}
          {content.bgImageUrl ? (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{
                backgroundImage: `url(${content.bgImageUrl})`,
                filter: content.blurBg ? "blur(12px)" : "none",
                transform: "scale(1.08)",
              }}
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-emerald-700 via-slate-900 to-indigo-900" />
          )}
          <div className="absolute inset-0 bg-black/60" />

          {/* Canvas */}
          <div className="relative z-10 min-h-screen w-full">
            {/* LOGO */}
            {content.logoUrl && (
              <div
                className="absolute flex justify-center items-center"
                style={{
                  left: `${content.logoX ?? 50}%`,
                  top: `${content.logoY ?? 22}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                <img
                  src={content.logoUrl}
                  alt="logo"
                  className="h-16 object-contain"
                />
              </div>
            )}

            {/* TÍTULO + SUBTÍTULO */}
            {(content.title || content.subtitle) && (
              <div
                className="absolute text-center px-4"
                style={{
                  left: `${content.titleX ?? 50}%`,
                  top: `${content.titleY ?? 35}%`,
                  transform: "translate(-50%, -50%)",
                }}
              >
                {content.title && (
                  <h1 className="text-3xl md:text-4xl font-extrabold tracking-wide mb-2">
                    {content.title}
                  </h1>
                )}
                {content.subtitle && (
                  <p className="text-sm md:text-base text-white/80">
                    {content.subtitle}
                  </p>
                )}
              </div>
            )}

            {/* ICONOS */}
            {gameIcons.length > 0 && (
              <div
                className="absolute flex flex-wrap justify-center gap-3 max-w-3xl mx-auto"
                style={{
                  left: "50%",
                  top: "52%",
                  transform: "translate(-50%, -50%)",
                }}
              >
                {gameIcons.map((icon) => (
                  <div
                    key={icon.id}
                    className="h-20 w-20 rounded-xl bg-black/40 border border-white/10 flex items-center justify-center overflow-hidden"
                  >
                    {icon.url && (
                      <img
                        src={icon.url}
                        alt="juego"
                        className="object-cover"
                        style={{
                          width: `${(icon.size ?? 1) * 100}%`,
                          height: `${(icon.size ?? 1) * 100}%`,
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* BOTONES WA (ROTACIÓN POR CLICK) */}
            {buttons.map((btn) => (
              <button
                key={btn.id}
                type="button"
                className="absolute inline-flex items-center justify-center gap-2 text-base md:text-lg rounded-lg px-9 py-3 hover:opacity-90 transition-opacity border-2"
                style={{
                  left: `${btn.x ?? 50}%`,
                  top: `${btn.y ?? 65}%`,
                  transform: "translate(-50%, -50%)",
                  color: buttonTextColor,
                  boxShadow: "0 0 22px rgba(34, 211, 238, 0.64)",
                  backgroundImage:
                    "linear-gradient(to right bottom, rgb(45,212,191), rgb(74,222,128))",
                  borderColor: "rgb(110,231,183)",
                }}
                onClick={() => handleWhatsAppClick(btn.id)}
                disabled={loadingWa}
              >
                <span className="inline-flex items-center justify-center">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 32 32"
                    className="w-5 h-5"
                  >
                    <circle cx="16" cy="16" r="16" fill="#25d366" />
                    <path
                      fill="#fff"
                      d="M21.6 10.4A6.5 6.5 0 0 0 16 8a6.5 6.5 0 0 0-6.5 6.5c0 1.1.3 2.1.8 3.1L9 23l5.6-1.4c.9.5 2 .7 3 .7a6.5 6.5 0 0 0 6.5-6.5c0-1.7-.6-3.3-1.5-4.4zm-5.6 9.8c-.9 0-1.8-.2-2.6-.7l-.2-.1-3.3.8.9-3.2-.1-.2a4.8 4.8 0 0 1-.7-2.5 4.9 4.9 0 0 1 8.3-3.4 4.8 4.8 0 0 1 1.6 3.5 4.9 4.9 0 0 1-4.9 4.8zm2.7-3.6c-.1-.1-.6-.3-1.2-.6-.6-.3-.9-.3-1.1 0-.3.3-.4.6-.6.7-.1.1-.3.2-.6-.1-.3-.2-1.1-.4-2.1-1.4-.8-.8-1.4-1.7-1.5-2-.2-.3 0-.5.1-.7l.2-.2c.1-.1.2-.3.3-.4.1-.2.1-.3.2-.4 0-.1 0-.3 0-.4l-.5-1.1c-.1-.4-.4-.4-.6-.4h-.5c-.2 0-.4 0-.6.2-.2.2-.8.8-.8 2s.8 2.3.9 2.4c.1.2 1.6 2.5 3.9 3.5.5.2.9.4 1.2.5.5.2.9.2 1.2.2.4 0 1.1-.4 1.3-.9.2-.5.2-.8.2-.9 0-.1-.1-.2-.2-.3z"
                    />
                  </svg>
                </span>
                <span>{loadingWa ? "Conectando…" : btn.label}</span>
              </button>
            ))}

            {/* TEXTOS */}
            {floatingTexts.map((t) => (
              <div
                key={t.id}
                className="absolute select-none"
                style={{
                  left: `${t.x}%`,
                  top: `${t.y}%`,
                  transform: "translate(-50%, -50%)",
                  color: t.color,
                  fontSize: t.fontSize,
                  fontWeight: t.fontWeight,
                  WebkitTextStroke:
                    t.strokeWidth > 0
                      ? `${t.strokeWidth}px ${t.strokeColor}`
                      : "none",
                }}
              >
                {t.text}
              </div>
            ))}
          </div>
        </div>
      </main>

      {/* ========== META PIXEL ========== */}
      {row.meta_pixel_id && (
        <>
          <Script id="fb-pixel" strategy="afterInteractive">
            {`
              !function(f,b,e,v,n,t,s)
              {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
              n.callMethod.apply(n,arguments):n.queue.push(arguments)};
              if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
              n.queue=[];t=b.createElement(e);t.async=!0;
              t.src=v;s=b.getElementsByTagName(e)[0];
              s.parentNode.insertBefore(t,s)}(window, document,'script',
              'https://connect.facebook.net/en_US/fbevents.js');
              fbq('init', '${row.meta_pixel_id}');
              fbq('track', 'PageView');
            `}
          </Script>

          <noscript>
            <img
              height="1"
              width="1"
              style={{ display: "none" }}
              src={`https://www.facebook.com/tr?id=${row.meta_pixel_id}&ev=PageView&noscript=1`}
            />
          </noscript>
        </>
      )}
    </>
  );
}

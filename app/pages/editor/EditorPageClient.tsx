"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { supabase } from "@/lib/supabaseClient";

/* ================== TYPES ================== */

type GameIcon = {
  id: string;
  url: string;
  size: number; // 0.5 – 1.5 (escala)
  x: number;
  y: number;
};

type FloatingText = {
  id: string;
  text: string;
  x: number; // % dentro del canvas
  y: number; // %
  color: string;
  strokeColor: string;
  strokeWidth: number;
  fontSize: number; // px
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
  blurBg: boolean;
  logoUrl?: string;

  title: string;
  subtitle: string;

  // posiciones drag
  logoX: number;
  logoY: number;
  titleX: number;
  titleY: number;
  subtitleX: number;
  subtitleY: number;

  // Botones de WhatsApp
  buttons: LandingButton[];

  // Colores generales del botón (se usan sobre el glow)
  buttonBgColor: string;
  buttonTextColor: string;

  // Iconos de juegos
  gameIcons: GameIcon[];

  // Textos flotantes
  floatingTexts: FloatingText[];
};

type LandingForm = {
  id?: string;
  internalName: string;
  slug: string;
  waMessage: string;
  pixelId: string;
  accessToken: string;
  content: LandingContent;
};

/* drag target */

type DragTarget =
  | { type: "floatingText"; id: string }
  | { type: "button"; id: string }
  | { type: "gameIcon"; id: string }
  | { type: "title" }
  | { type: "subtitle" }
  | { type: "logo" };

/* ================== HELPERS ================== */

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

// helper para subir archivos al bucket "uploads"
async function uploadToSupabase(file: File, folder = "landing-editor") {
  const ext = file.name.split(".").pop() || "bin";
  const path = `${folder}/${Date.now()}-${Math.random()
    .toString(36)
    .slice(2)}.${ext}`;

  const { error } = await supabase.storage.from("uploads").upload(path, file, {
    cacheControl: "3600",
    upsert: false,
  });

  if (error) throw error;
  const { data } = supabase.storage.from("uploads").getPublicUrl(path);
  return data.publicUrl;
}

/* ================== DEFAULT CONTENT ================== */

const defaultContent: LandingContent = {
  bgImageUrl: "",
  blurBg: true,
  logoUrl: "",
  title: "RECLAMÁ TU BONO DE 30% EXTRA",
  subtitle: "Landing simple para tus campañas de Meta",

  logoX: 50,
  logoY: 18,
  titleX: 50,
  titleY: 32,
  subtitleX: 50,
  subtitleY: 40,

  buttons: [
    {
      id: "btn_1",
      label: "Ir al WhatsApp ahora",
      x: 50,
      y: 65,
    },
  ],

  buttonBgColor: "#22d3ee",
  buttonTextColor: "#000000",

  gameIcons: [],

  floatingTexts: [],
};

/* ================== COMPONENT ================== */

export default function PagesEditor() {
  const searchParams = useSearchParams();
  const editingIdFromUrl = searchParams.get("id");
  const router = useRouter();

  const [form, setForm] = useState<LandingForm>({
    internalName: "Landing sin título",
    slug: "",
    waMessage: "Hola! Quiero aprovechar la promo 👋",
    pixelId: "",
    accessToken: "",
    // clonamos defaultContent para no mutarlo
    content: { ...defaultContent, buttons: [...defaultContent.buttons] },
  });

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [viewport, setViewport] = useState<"desktop" | "mobile">("desktop");
  const [error, setError] = useState<string | null>(null);

  // cambios sin guardar + modal de salida
  const [isDirty, setIsDirty] = useState(false);
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const markDirty = () => setIsDirty(true);

  // refs input file
  const bgInputRef = useRef<HTMLInputElement | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const addGameImgInputRef = useRef<HTMLInputElement | null>(null);
  const replaceGameImgInputRef = useRef<HTMLInputElement | null>(null);
  const [activeGameId, setActiveGameId] = useState<string | null>(null);

  // canvas para drag
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState<DragTarget | null>(null);
  const dragOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  /* ================== LOAD ================== */

  useEffect(() => {
    const load = async () => {
      // 👉 Si NO hay id en la URL, estamos creando una nueva: no cargar nada
      if (!editingIdFromUrl) {
        setLoading(false);
        setError(null);
        setForm((prev) => ({
          ...prev,
          id: undefined,
          content: {
            ...defaultContent,
            buttons: [...defaultContent.buttons],
            gameIcons: [],
            floatingTexts: [],
          },
        }));
        setIsDirty(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`/api/pages/${editingIdFromUrl}`);
        if (!res.ok) {
          if (res.status === 404) {
            // si no existe, dejamos el formulario vacío (modo crear)
            setLoading(false);
            return;
          }
          throw new Error("Error al cargar la landing");
        }

        const { page } = await res.json();
        const row = page;
        if (!row) {
          setLoading(false);
          return;
        }

        const rawContent = (row.content || {}) as Partial<LandingContent>;

        let mergedContent: LandingContent = {
          ...defaultContent,
          ...rawContent,
        };

        // compat: si no hay buttons
        if (!mergedContent.buttons || mergedContent.buttons.length === 0) {
          mergedContent.buttons = [
            {
              id: "btn_1",
              label:
                (rawContent as any)?.buttonText ||
                defaultContent.buttons[0].label,
              x: 50,
              y: 65,
            },
          ];
        }

        // normalizar coords de botones
        mergedContent.buttons = mergedContent.buttons.map((b, index) => ({
          ...b,
          x: b.x ?? 50,
          y: b.y ?? 65 + index * 8,
        }));

        // normalizar coords de iconos
        const icons = mergedContent.gameIcons || [];
        mergedContent.gameIcons = icons.map((icon, index) => {
          const spread =
            50 + (index - (icons.length - 1) / 2) * 12; // para que queden centrados
          return {
            ...icon,
            x: icon.x ?? spread,
            y: icon.y ?? 50,
          };
        });

        // asegurar coords básicas
        mergedContent.logoX = mergedContent.logoX ?? 50;
        mergedContent.logoY = mergedContent.logoY ?? 18;
        mergedContent.titleX = mergedContent.titleX ?? 50;
        mergedContent.titleY = mergedContent.titleY ?? 32;
        mergedContent.subtitleX = mergedContent.subtitleX ?? 50;
        mergedContent.subtitleY = mergedContent.subtitleY ?? 40;

        setForm({
          id: row.id,
          internalName: row.internal_name ?? "Landing sin título",
          slug: row.slug ?? "",
          waMessage: row.wa_message ?? "Hola! Quiero aprovechar la promo 👋",
          pixelId: row.meta_pixel_id ?? "",
          accessToken: row.meta_access_token ?? "",
          content: mergedContent,
        });

        setIsDirty(false); // al cargar desde la BD no hay cambios pendientes
      } catch (e: any) {
        console.error(e);
        setError(e.message ?? "Error al cargar la landing");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, [editingIdFromUrl]);

  /* ================== HELPERS ================== */

  const update = (patch: Partial<LandingForm>) => {
    setForm((prev) => ({ ...prev, ...patch }));
    markDirty();
  };

  const updateContent = (patch: Partial<LandingContent>) => {
    setForm((prev) => ({
      ...prev,
      content: { ...prev.content, ...patch },
    }));
    markDirty();
  };

  const handleBgChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadToSupabase(file, "landing-bg");
      updateContent({ bgImageUrl: url });
    } catch (err) {
      console.error(err);
      alert("No se pudo subir el fondo.");
    } finally {
      e.target.value = "";
    }
  };

  const handleLogoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadToSupabase(file, "landing-logo");
      updateContent({ logoUrl: url });
    } catch (err) {
      console.error(err);
      alert("No se pudo subir el logo.");
    } finally {
      e.target.value = "";
    }
  };

  /* --------- ICONOS DE JUEGOS (GRID/DRAG) --------- */

  const handleAddGameImageClick = () => {
    addGameImgInputRef.current?.click();
  };

  const handleAddGameImageSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const url = await uploadToSupabase(file, "landing-games");
      const newIcon: GameIcon = {
        id: `g_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        url,
        size: 1,
        x: 50,
        y: 50,
      };
      const nextIcons = [...form.content.gameIcons, newIcon];
      updateContent({ gameIcons: nextIcons });
    } catch (err) {
      console.error(err);
      alert("No se pudo subir la imagen.");
    } finally {
      e.target.value = "";
    }
  };

  const handleReplaceGameImage = (id: string) => {
    setActiveGameId(id);
    replaceGameImgInputRef.current?.click();
  };

  const handleReplaceGameImageSelected = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = e.target.files?.[0];
    if (!file || !activeGameId) return;
    try {
      const url = await uploadToSupabase(file, "landing-games");
      const nextIcons = form.content.gameIcons.map((icon) =>
        icon.id === activeGameId ? { ...icon, url } : icon
      );
      updateContent({ gameIcons: nextIcons });
    } catch (err) {
      console.error(err);
      alert("No se pudo subir la imagen.");
    } finally {
      e.target.value = "";
      setActiveGameId(null);
    }
  };

  const handleChangeGameSize = (id: string, size: number) => {
    const nextIcons = form.content.gameIcons.map((icon) =>
      icon.id === id ? { ...icon, size } : icon
    );
    updateContent({ gameIcons: nextIcons });
  };

  const handleRemoveGameIcon = (id: string) => {
    const nextIcons = form.content.gameIcons.filter((icon) => icon.id !== id);
    updateContent({ gameIcons: nextIcons });
  };

  const moveGameIcon = (id: string, direction: "up" | "down") => {
    const icons = [...form.content.gameIcons];
    const index = icons.findIndex((i) => i.id === id);
    if (index === -1) return;

    const newIndex = direction === "up" ? index - 1 : index + 1;
    if (newIndex < 0 || newIndex >= icons.length) return;

    const [item] = icons.splice(index, 1);
    icons.splice(newIndex, 0, item);
    updateContent({ gameIcons: icons });
  };

  const handleUpdateGameIcon = (id: string, patch: Partial<GameIcon>) => {
    const next = form.content.gameIcons.map((icon) =>
      icon.id === id ? { ...icon, ...patch } : icon
    );
    updateContent({ gameIcons: next });
  };

  /* --------- TEXTOS FLOTANTES (DRAG) --------- */

  const handleAddFloatingText = () => {
    const newText: FloatingText = {
      id: `t_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      text: "Nuevo texto",
      x: 50,
      y: 40,
      color: "#ffffff",
      strokeColor: "#000000",
      strokeWidth: 0,
      fontSize: 20,
      fontWeight: "normal",
    };
    updateContent({
      floatingTexts: [...form.content.floatingTexts, newText],
    });
  };

  const handleUpdateFloatingText = (
    id: string,
    patch: Partial<FloatingText>
  ) => {
    const next = form.content.floatingTexts.map((t) =>
      t.id === id ? { ...t, ...patch } : t
    );
    updateContent({ floatingTexts: next });
  };

  const handleRemoveFloatingText = (id: string) => {
    updateContent({
      floatingTexts: form.content.floatingTexts.filter((t) => t.id !== id),
    });
  };

  /* --------- BOTONES WHATSAPP --------- */

  const handleAddButton = () => {
    const newBtn: LandingButton = {
      id: `btn_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      label: "Nuevo botón",
      x: 50,
      y: 65,
    };
    updateContent({ buttons: [...form.content.buttons, newBtn] });
  };

  const handleUpdateButton = (id: string, patch: Partial<LandingButton>) => {
    const next = form.content.buttons.map((b) =>
      b.id === id ? { ...b, ...patch } : b
    );
    updateContent({ buttons: next });
  };

  const handleRemoveButton = (id: string) => {
    updateContent({
      buttons: form.content.buttons.filter((b) => b.id !== id),
    });
  };

  /* --------- DRAG GENERAL --------- */

  const getTargetPosition = (
    target: DragTarget
  ): { x: number; y: number } | null => {
    switch (target.type) {
      case "floatingText": {
        const t = form.content.floatingTexts.find(
          (ft) => ft.id === target.id
        );
        return t ? { x: t.x, y: t.y } : null;
      }
      case "button": {
        const b = form.content.buttons.find((bt) => bt.id === target.id);
        return b ? { x: b.x, y: b.y } : null;
      }
      case "gameIcon": {
        const i = form.content.gameIcons.find((gi) => gi.id === target.id);
        return i ? { x: i.x, y: i.y } : null;
      }
      case "title":
        return { x: form.content.titleX, y: form.content.titleY };
      case "subtitle":
        return { x: form.content.subtitleX, y: form.content.subtitleY };
      case "logo":
        return { x: form.content.logoX, y: form.content.logoY };
      default:
        return null;
    }
  };

  const startDrag = (
    target: DragTarget,
    clientX: number,
    clientY: number
  ) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const base = getTargetPosition(target);
    if (!base) return;

    const rect = canvas.getBoundingClientRect();
    const relX = ((clientX - rect.left) / rect.width) * 100;
    const relY = ((clientY - rect.top) / rect.height) * 100;

    dragOffsetRef.current = {
      x: relX - base.x,
      y: relY - base.y,
    };
    setDragging(target);
  };

  const applyDrag = (newX: number, newY: number) => {
    if (!dragging) return;

    switch (dragging.type) {
      case "floatingText":
        handleUpdateFloatingText(dragging.id, { x: newX, y: newY });
        break;
      case "button":
        handleUpdateButton(dragging.id, { x: newX, y: newY });
        break;
      case "gameIcon":
        handleUpdateGameIcon(dragging.id, { x: newX, y: newY });
        break;
      case "title":
        updateContent({ titleX: newX, titleY: newY });
        break;
      case "subtitle":
        updateContent({ subtitleX: newX, subtitleY: newY });
        break;
      case "logo":
        updateContent({ logoX: newX, logoY: newY });
        break;
    }
  };

  const handleCanvasMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * 100;
    const relY = ((e.clientY - rect.top) / rect.height) * 100;

    const newX = clamp(relX - dragOffsetRef.current.x, 0, 100);
    const newY = clamp(relY - dragOffsetRef.current.y, 0, 100);

    applyDrag(newX, newY);
  };

  const handleCanvasTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const touch = e.touches[0];
    if (!touch) return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    const rect = canvas.getBoundingClientRect();
    const relX = ((touch.clientX - rect.left) / rect.width) * 100;
    const relY = ((touch.clientY - rect.top) / rect.height) * 100;

    const newX = clamp(relX - dragOffsetRef.current.x, 0, 100);
    const newY = clamp(relY - dragOffsetRef.current.y, 0, 100);

    applyDrag(newX, newY);
  };

  const stopDrag = () => setDragging(null);

  /* ================== SAVE ================== */

  const handleSave = async () => {
    if (!form.slug.trim()) {
      alert("Definí un slug para la URL pública.");
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const payload = {
        internal_name: form.internalName.trim() || "Landing sin título",
        slug: form.slug.trim(),
        wa_message: form.waMessage.trim(),
        meta_pixel_id: form.pixelId.trim() || null,
        meta_access_token: form.accessToken.trim() || null,
        content: form.content,
      };

      let pageId = form.id;

      if (pageId) {
        // EDITAR
        const res = await fetch(`/api/pages/${pageId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          console.error("Error al actualizar landing", await res.text());
          throw new Error("No se pudo actualizar la landing.");
        }

        const { page } = await res.json();
        pageId = page.id;
      } else {
        // CREAR NUEVA
        const res = await fetch("/api/pages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          console.error("Error al crear landing", await res.text());
          throw new Error("No se pudo crear la landing.");
        }

        const { page } = await res.json();
        pageId = page.id;

        // actualizamos form y URL a modo edición
        setForm((prev) => ({ ...prev, id: pageId }));
        router.replace(`/pages/editor?id=${pageId}`);
      }

      setIsDirty(false);
      alert("Landing guardada ✅");
    } catch (e: any) {
      console.error(e);
      setError(e.message ?? "No se pudo guardar.");
    } finally {
      setSaving(false);
    }
  };

  /* ================== UI ================== */

  const publicUrl = form.slug ? `/p/${form.slug}` : "/p/…";

  const WhatsAppIcon = (
    <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-[#25D366] text-white">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 32 32"
        className="h-4 w-4"
      >
        <path
          fill="currentColor"
          d="M16.04 5C10.55 5 6.11 9.44 6.11 14.93c0 2.1.62 4.02 1.8 5.7L6 27l6.52-1.88c1.6.88 3.4 1.34 5.25 1.34c5.49 0 9.93-4.44 9.93-9.93S21.53 5 16.04 5zm0 17.94c-1.6 0-3.16-.43-4.52-1.25l-.32-.19L8.5 22.5l.99-2.61l-.21-.34a7.92 7.92 0 0 1-1.26-4.32c0-4.35 3.54-7.89 7.89-7.89s7.89 3.54 7.89 7.89s-3.54 7.89-7.89 7.89zm4.33-5.87c-.24-.12-1.44-.71-1.66-.79c-.22-.08-.38-.12-.54.12c-.16.24-.62.79-.76.95c-.14.16-.28.18-.52.06c-.24-.12-1.02-.38-1.94-1.21c-.72-.64-1.21-1.43-1.36-1.67c-.14-.24-.01-.37.11-.49c.11-.11.24-.28.36-.42c.12-.14.16-.24.24-.4c.08-.16.04-.3-.02-.42c-.06-.12-.54-1.29-.74-1.77c-.2-.48-.4-.41-.54-.42h-.46c-.16 0-.42.06-.64.3c-.22.24-.84.82-.84 2.01c0 1.19.86 2.35.98 2.51c.12.16 1.7 2.6 4.12 3.64c.57.25 1.01.4 1.35.51c.57.18 1.09.16 1.5.1c.46-.07 1.44-.59 1.64-1.17c.2-.58.2-1.07.14-1.17c-.06-.1-.22-.16-.46-.28z"
        />
      </svg>
    </span>
  );

  return (
    <main className="flex h-[calc(100vh-56px)] bg-[#050816] text-white">
      {/* Panel izquierdo - CONFIG */}
      <aside className="w-80 shrink-0 border-r border-white/10 bg-black/40 p-4 overflow-y-auto">
        {/* Header con X */}
        <div className="flex items-start justify-between mb-4">
          <div>
            <h1 className="text-sm font-semibold">
              Editor de páginas · Circo Tracking
            </h1>
            <p className="text-xs text-white/60">
              Configurá los datos de la landing y el tracking. A la derecha ves
              el preview en tiempo real.
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (isDirty) {
                setShowExitConfirm(true);
              } else {
                router.push("/pages");
              }
            }}
            className="ml-2 flex h-7 w-7 items-center justify-center rounded-full bg-white/10 text-sm hover:bg-white/20"
            aria-label="Cerrar editor"
          >
            ×
          </button>
        </div>

        {loading && (
          <p className="mb-3 text-[11px] text-white/60">Cargando landing…</p>
        )}

        {/* Nombre interno */}
        <div className="space-y-1 mb-3">
          <label className="text-[11px] text-white/50">Nombre interno</label>
          <input
            value={form.internalName}
            onChange={(e) => update({ internalName: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
        </div>

        {/* Slug */}
        <div className="space-y-1 mb-3">
          <label className="text-[11px] text-white/50">Slug (URL)</label>
          <input
            placeholder="ej: bono-30-flow"
            value={form.slug}
            onChange={(e) =>
              update({
                slug: e.target.value.replace(/\s+/g, "-").toLowerCase(),
              })
            }
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
          <p className="text-[11px] text-white/40">
            URL pública: <code>{publicUrl}</code>
          </p>
        </div>

        {/* Mensaje por defecto */}
        <div className="space-y-1 mb-3">
          <label className="text-[11px] text-white/50">
            Mensaje por defecto (cuando hacen click)
          </label>
          <textarea
            rows={2}
            value={form.waMessage}
            onChange={(e) => update({ waMessage: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none resize-none"
          />
        </div>

        {/* Meta Pixel */}
        <div className="space-y-1 mb-3">
          <label className="text-[11px] text-white/50">Meta Pixel ID</label>
          <input
            value={form.pixelId}
            onChange={(e) => update({ pixelId: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
        </div>

        {/* Access Token */}
        <div className="space-y-1 mb-4">
          <label className="text-[11px] text-white/50">Access Token</label>
          <input
            value={form.accessToken}
            onChange={(e) => update({ accessToken: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          className="w-full rounded-md bg-emerald-500 py-2 text-sm font-semibold text-black hover:bg-emerald-400 disabled:opacity-60"
        >
          {saving ? "Guardando…" : "Guardar landing"}
        </button>

        {error && (
          <p className="mt-2 text-[11px] text-red-400 bg-red-950/30 border border-red-500/40 rounded px-2 py-1">
            {error}
          </p>
        )}
      </aside>

      {/* CENTRO - PREVIEW */}
      <section className="flex-1 flex flex-col">
        {/* Toggle Desktop / Mobile */}
        <div className="flex items-center justify-center gap-2 border-b border-white/10 bg-black/40 py-2">
          <button
            onClick={() => setViewport("desktop")}
            className={`rounded-md px-3 py-1 text-xs border ${
              viewport === "desktop"
                ? "border-emerald-400 text-emerald-300"
                : "border-white/20 text-white/60"
            }`}
          >
            🖥 Desktop
          </button>
          <button
            onClick={() => setViewport("mobile")}
            className={`rounded-md px-3 py-1 text-xs border ${
              viewport === "mobile"
                ? "border-emerald-400 text-emerald-300"
                : "border-white/20 text-white/60"
            }`}
          >
            📱 Mobile
          </button>
        </div>

        <div className="flex-1 grid place-items-center bg-[#050816] overflow-auto">
          <div
            className="rounded-2xl border border-white/10 bg-black/60 shadow-2xl overflow-hidden"
            style={{
              width: viewport === "mobile" ? 420 : 960,
              maxWidth: "95vw",
              height: viewport === "mobile" ? 720 : 560,
            }}
          >
            {/* fondo */}
            <div
              className="relative w-full h-full"
              ref={canvasRef}
              onMouseMove={handleCanvasMouseMove}
              onMouseUp={stopDrag}
              onMouseLeave={stopDrag}
              onTouchMove={handleCanvasTouchMove}
              onTouchEnd={stopDrag}
            >
              {form.content.bgImageUrl ? (
                <div
                  className="absolute inset-0 bg-cover bg-center"
                  style={{
                    backgroundImage: `url(${form.content.bgImageUrl})`,
                    filter: form.content.blurBg ? "blur(12px)" : "none",
                    transform: "scale(1.08)",
                  }}
                />
              ) : (
                <div className="absolute inset-0 bg-gradient-to-br from-emerald-700 via-slate-900 to-indigo-900" />
              )}
              <div className="absolute inset-0 bg-black/60" />

              {/* contenido */}
              <div className="relative z-10 h-full w-full px-6">
                {/* Logo draggable */}
                {form.content.logoUrl && (
                  <img
                    src={form.content.logoUrl}
                    alt="logo"
                    className="h-16 object-contain absolute cursor-move"
                    style={{
                      left: `${form.content.logoX}%`,
                      top: `${form.content.logoY}%`,
                      transform: "translate(-50%, -50%)",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startDrag(
                        { type: "logo" },
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      e.stopPropagation();
                      startDrag(
                        { type: "logo" },
                        touch.clientX,
                        touch.clientY
                      );
                    }}
                  />
                )}

                {/* Título draggable */}
                <div
                  className="absolute cursor-move text-center"
                  style={{
                    left: `${form.content.titleX}%`,
                    top: `${form.content.titleY}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startDrag(
                      { type: "title" },
                      e.clientX,
                      e.clientY
                    );
                  }}
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    if (!touch) return;
                    e.stopPropagation();
                    startDrag(
                      { type: "title" },
                      touch.clientX,
                      touch.clientY
                    );
                  }}
                >
                  <h2 className="text-3xl md:text-4xl font-extrabold tracking-wide mb-2">
                    {form.content.title}
                  </h2>
                </div>

                {/* Subtítulo draggable */}
                <div
                  className="absolute cursor-move text-center"
                  style={{
                    left: `${form.content.subtitleX}%`,
                    top: `${form.content.subtitleY}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    startDrag(
                      { type: "subtitle" },
                      e.clientX,
                      e.clientY
                    );
                  }}
                  onTouchStart={(e) => {
                    const touch = e.touches[0];
                    if (!touch) return;
                    e.stopPropagation();
                    startDrag(
                      { type: "subtitle" },
                      touch.clientX,
                      touch.clientY
                    );
                  }}
                >
                  <p className="text-sm md:text-base text-white/80">
                    {form.content.subtitle}
                  </p>
                </div>

                {/* Iconos / Imágenes en canvas (draggables) */}
                {form.content.gameIcons.map((icon) => (
                  <div
                    key={icon.id}
                    className="absolute cursor-move"
                    style={{
                      left: `${icon.x}%`,
                      top: `${icon.y}%`,
                      transform: "translate(-50%, -50%)",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startDrag(
                        { type: "gameIcon", id: icon.id },
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      e.stopPropagation();
                      startDrag(
                        { type: "gameIcon", id: icon.id },
                        touch.clientX,
                        touch.clientY
                      );
                    }}
                  >
                    {icon.url && (
                      <img
                        src={icon.url}
                        alt="imagen"
                        className="rounded-xl shadow-lg pointer-events-none"
                        style={{
                          width: `${icon.size * 260}px`, // base “normal”
                          height: "auto",
                        }}
                      />
                    )}
                  </div>
                ))}

                {/* Botones de WhatsApp (draggables) */}
                {form.content.buttons.map((btn) => (
                  <button
                    key={btn.id}
                    type="button"
                    className="text-base md:text-lg rounded-md inline-flex items-center justify-center gap-2 hover:opacity-90 transition-opacity border-2 px-9 py-3 absolute cursor-move"
                    style={{
                      left: `${btn.x}%`,
                      top: `${btn.y}%`,
                      transform: "translate(-50%, -50%)",
                      color: form.content.buttonTextColor,
                      boxShadow: "0 0 22px rgba(34, 211, 238, 0.64)",
                      backgroundImage:
                        "linear-gradient(to right bottom, rgb(45,212,191), rgb(74,222,128))",
                      borderColor: "rgb(110,231,183)",
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startDrag(
                        { type: "button", id: btn.id },
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      e.stopPropagation();
                      startDrag(
                        { type: "button", id: btn.id },
                        touch.clientX,
                        touch.clientY
                      );
                    }}
                  >
                    {WhatsAppIcon}
                    {btn.label}
                  </button>
                ))}

                {/* Textos flotantes (draggables) */}
                {form.content.floatingTexts.map((t) => (
                  <div
                    key={t.id}
                    className="absolute cursor-move select-none"
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
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startDrag(
                        { type: "floatingText", id: t.id },
                        e.clientX,
                        e.clientY
                      );
                    }}
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      e.stopPropagation();
                      startDrag(
                        { type: "floatingText", id: t.id },
                        touch.clientX,
                        touch.clientY
                      );
                    }}
                  >
                    {t.text}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Panel derecho - DISEÑO */}
      <aside className="w-96 shrink-0 border-l border-white/10 bg-black/40 p-4 overflow-y-auto">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h2 className="text-sm font-semibold">Diseño de la landing</h2>
            <p className="text-[11px] text-white/60">
              Simple y rápido, estilo Convertix.
            </p>
          </div>
        </div>

        {/* FONDO */}
        <div className="mb-4 space-y-2">
          <p className="text-xs font-semibold text-white/70">Fondo (imagen)</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => bgInputRef.current?.click()}
              className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
            >
              Cambiar fondo
            </button>
            <button
              type="button"
              onClick={() => updateContent({ bgImageUrl: "" })}
              className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] hover:bg-white/5"
            >
              Sin fondo
            </button>
            <input
              ref={bgInputRef}
              type="file"
              accept="image/*"
              onChange={handleBgChange}
              className="hidden"
            />
          </div>

          <label className="inline-flex items-center gap-2 text-[11px] text-white/70">
            <input
              type="checkbox"
              checked={form.content.blurBg}
              onChange={(e) =>
                updateContent({ blurBg: e.target.checked })
              }
            />
            Desenfocar fondo (efecto casino)
          </label>
        </div>

        {/* LOGO */}
        <div className="mb-4 space-y-2">
          <p className="text-xs font-semibold text-white/70">Logo</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => logoInputRef.current?.click()}
              className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15"
            >
              Subir logo
            </button>
            {form.content.logoUrl && (
              <button
                type="button"
                onClick={() => updateContent({ logoUrl: "" })}
                className="rounded-md border border-white/15 px-3 py-1.5 text-[11px] hover:bg-white/5"
              >
                Quitar
              </button>
            )}
            <input
              ref={logoInputRef}
              type="file"
              accept="image/*"
              onChange={handleLogoChange}
              className="hidden"
            />
          </div>
        </div>

        {/* TEXTOS */}
        <div className="mb-3 space-y-2">
          <label className="text-xs text-white/70">Título (headline)</label>
          <input
            value={form.content.title}
            onChange={(e) => updateContent({ title: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
        </div>

        <div className="mb-3 space-y-2">
          <label className="text-xs text-white/70">
            Subtítulo (debajo del título)
          </label>
          <input
            value={form.content.subtitle}
            onChange={(e) => updateContent({ subtitle: e.target.value })}
            className="w-full rounded-md border border-white/15 bg-black/40 px-3 py-2 text-sm outline-none"
          />
        </div>

        {/* BOTONES WHATSAPP */}
        <div className="mb-4 space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-white/70">
              Botones de WhatsApp
            </p>
            <button
              type="button"
              onClick={handleAddButton}
              className="rounded-md bg-white/10 px-2 py-1 text-[11px] hover:bg-white/15"
            >
              + Agregar botón
            </button>
          </div>

          <div className="space-y-2">
            {form.content.buttons.map((btn, index) => (
              <div
                key={btn.id}
                className="rounded-md border border-white/15 bg-black/40 px-3 py-2 text-xs space-y-1"
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold">
                    Botón {index + 1}
                  </span>
                  {form.content.buttons.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleRemoveButton(btn.id)}
                      className="text-[11px] text-red-300 hover:text-red-200"
                    >
                      Eliminar
                    </button>
                  )}
                </div>
                <label className="text-[11px] text-white/60">
                  Texto del botón
                </label>
                <input
                  value={btn.label}
                  onChange={(e) =>
                    handleUpdateButton(btn.id, {
                      label: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs outline-none"
                />
              </div>
            ))}
          </div>
        </div>

        {/* Colores del botón */}
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div>
            <p className="text-[11px] text-white/70 mb-1">
              Color base (glow)
            </p>
            <input
              type="color"
              value={form.content.buttonBgColor}
              onChange={(e) =>
                updateContent({ buttonBgColor: e.target.value })
              }
              className="h-9 w-full rounded-md border border-white/15 bg-black/40"
            />
          </div>
          <div>
            <p className="text-[11px] text-white/70 mb-1">
              Color de texto
            </p>
            <input
              type="color"
              value={form.content.buttonTextColor}
              onChange={(e) =>
                updateContent({ buttonTextColor: e.target.value })
              }
              className="h-9 w-full rounded-md border border-white/15 bg-black/40"
            />
          </div>
        </div>

        {/* ICONOS DE JUEGOS */}
        <div className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-semibold text-white/70">
                Iconos de juegos (grid)
              </p>
              <p className="text-[11px] text-white/50">
                Opcional, podés agregar varias imágenes.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleAddGameImageClick}
            className="rounded-md bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 mb-3"
          >
            Agregar imagen
          </button>
          <input
            ref={addGameImgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleAddGameImageSelected}
          />
          <input
            ref={replaceGameImgInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleReplaceGameImageSelected}
          />

          <div className="space-y-2">
            {form.content.gameIcons.length === 0 && (
              <p className="text-[11px] text-white/45">
                Todavía no agregaste imágenes.
              </p>
            )}

            {form.content.gameIcons.map((icon, index) => (
              <div
                key={icon.id}
                className="rounded-md border border-white/15 bg-black/40 px-3 py-2 text-xs flex items-center gap-3"
              >
                <div className="h-10 w-10 rounded-md overflow-hidden bg-black/60 flex items-center justify-center">
                  {icon.url ? (
                    <img
                      src={icon.url}
                      alt="icono juego"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="text-[10px] text-white/50">
                      Sin imagen
                    </span>
                  )}
                </div>

                <div className="flex-1 space-y-1">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleReplaceGameImage(icon.id)}
                      className="rounded-md border border-white/20 px-2 py-1 text-[11px] hover:bg-white/5"
                    >
                      Subir nueva imagen
                    </button>
                    <button
                      type="button"
                      onClick={() => moveGameIcon(icon.id, "up")}
                      disabled={index === 0}
                      className="rounded-md border border-white/20 px-1.5 py-1 text-[11px] hover:bg-white/5 disabled:opacity-40"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveGameIcon(icon.id, "down")}
                      disabled={
                        index === form.content.gameIcons.length - 1
                      }
                      className="rounded-md border border-white/20 px-1.5 py-1 text-[11px] hover:bg-white/5 disabled:opacity-40"
                    >
                      ↓
                    </button>
                  </div>

                  <div>
                    <p className="text-[10px] text-white/50">Tamaño</p>
                    <input
                      type="range"
                      min={0.2}
                      max={3}
                      step={0.05}
                      value={icon.size}
                      onChange={(e) =>
                        handleChangeGameSize(
                          icon.id,
                          Number(e.target.value)
                        )
                      }
                      className="w-full"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => handleRemoveGameIcon(icon.id)}
                  className="rounded-md border border-red-500/60 px-2 py-1 text-[11px] text-red-300 hover:bg-red-500/10"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>

        {/* TEXTOS FLOTANTES */}
        <div className="mb-8">
          <div className="flex items-center justify-between mb-2">
            <div>
              <p className="text-xs font-semibold text-white/70">
                Textos flotantes
              </p>
              <p className="text-[11px] text-white/50">
                Podés agregarlos y moverlos libremente en el canvas.
              </p>
            </div>
            <button
              type="button"
              onClick={handleAddFloatingText}
              className="rounded-md bg-white/10 px-2 py-1 text-[11px] hover:bg-white/15"
            >
              + Agregar texto
            </button>
          </div>

          <div className="space-y-2">
            {form.content.floatingTexts.length === 0 && (
              <p className="text-[11px] text-white/45">
                Todavía no agregaste textos flotantes.
              </p>
            )}

            {form.content.floatingTexts.map((t) => (
              <div
                key={t.id}
                className="rounded-md border border-white/15 bg-black/40 px-3 py-2 text-xs space-y-1"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="font-semibold">Texto</span>
                  <button
                    type="button"
                    onClick={() => handleRemoveFloatingText(t.id)}
                    className="text-[11px] text-red-300 hover:text-red-200"
                  >
                    Eliminar
                  </button>
                </div>

                <textarea
                  rows={2}
                  value={t.text}
                  onChange={(e) =>
                    handleUpdateFloatingText(t.id, {
                      text: e.target.value,
                    })
                  }
                  className="w-full rounded-md border border-white/15 bg-black/40 px-2 py-1 text-xs outline-none resize-none"
                />

                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div>
                    <p className="text-[10px] text-white/60 mb-0.5">
                      Color
                    </p>
                    <input
                      type="color"
                      value={t.color}
                      onChange={(e) =>
                        handleUpdateFloatingText(t.id, {
                          color: e.target.value,
                        })
                      }
                      className="w-full h-7 rounded border border-white/15 bg-black/40"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] text-white/60 mb-0.5">
                      Tamaño
                    </p>
                    <input
                      type="range"
                      min={10}
                      max={40}
                      step={1}
                      value={t.fontSize}
                      onChange={(e) =>
                        handleUpdateFloatingText(t.id, {
                          fontSize: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 mt-1">
                  <div>
                    <p className="text-[10px] text-white/60 mb-0.5">
                      Color trazo
                    </p>
                    <input
                      type="color"
                      value={t.strokeColor}
                      onChange={(e) =>
                        handleUpdateFloatingText(t.id, {
                          strokeColor: e.target.value,
                        })
                      }
                      className="w-full h-7 rounded border border-white/15 bg-black/40"
                    />
                  </div>
                  <div>
                    <p className="text-[10px] text-white/60 mb-0.5">
                      Grosor trazo
                    </p>
                    <input
                      type="range"
                      min={0}
                      max={3}
                      step={0.5}
                      value={t.strokeWidth}
                      onChange={(e) =>
                        handleUpdateFloatingText(t.id, {
                          strokeWidth: Number(e.target.value),
                        })
                      }
                      className="w-full"
                    />
                  </div>
                </div>

                <div className="mt-1">
                  <label className="inline-flex items-center gap-1 text-[10px] text-white/70">
                    <input
                      type="checkbox"
                      checked={t.fontWeight === "bold"}
                      onChange={(e) =>
                        handleUpdateFloatingText(t.id, {
                          fontWeight: e.target.checked
                            ? "bold"
                            : "normal",
                        })
                      }
                    />
                    Negrita
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      {/* Modal salir sin guardar */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-sm rounded-xl border border-white/20 bg-[#050816] p-4 shadow-xl">
            <h2 className="text-sm font-semibold mb-1">
              ¿Deseás salir sin guardar los cambios?
            </h2>
            <p className="text-xs text-white/60 mb-4">
              Si salís ahora, los cambios no guardados se van a perder.
            </p>
            <div className="flex justify-end gap-2 text-xs">
              <button
                type="button"
                onClick={() => setShowExitConfirm(false)}
                className="rounded-md border border-white/30 px-3 py-1 hover:bg-white/10"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => {
                  setShowExitConfirm(false);
                  router.push("/pages");
                }}
                className="rounded-md bg-red-500 px-3 py-1 font-semibold text-black hover:bg-red-400"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
// app/pages/page.tsx
"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type LandingRow = {
  id: string;
  internal_name: string | null;
  slug: string | null;
  content: any;
  created_at: string;
  wa_message?: string | null;
  meta_pixel_id?: string | null;
  meta_access_token?: string | null;
};

export default function PagesList() {
  const router = useRouter();
  const [pages, setPages] = useState<LandingRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  // ========= LOAD PAGES DESDE /api/pages (aislado por owner) =========
  useEffect(() => {
    const load = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch("/api/pages");
        const json = await res.json();

        if (!res.ok) {
          throw new Error(json?.error || "No se pudieron cargar las páginas.");
        }

        setPages((json.pages || []) as LandingRow[]);
      } catch (e: any) {
        console.error(e);
        setError(e.message ?? "No se pudieron cargar las páginas.");
      } finally {
        setLoading(false);
      }
    };

    load();
  }, []);

  const toggleMenu = (id: string) => {
    setMenuOpenId((prev) => (prev === id ? null : id));
  };

  /* ====== ACCIONES 3 PUNTITOS ====== */

  const handleVisit = (p: LandingRow) => {
    if (!p.slug) {
      alert("Esta landing todavía no tiene slug configurado.");
      return;
    }
    window.open(`/p/${p.slug}`, "_blank");
  };

  const handleEdit = (p: LandingRow) => {
    router.push(`/pages/editor?id=${p.id}`);
  };

  // DUPLICAR usando POST /api/pages (el backend asigna owner_id)
  const handleDuplicate = async (p: LandingRow) => {
    try {
      const baseSlug = p.slug || "landing";
      const newSlug = `${baseSlug}-copy-${Math.floor(Date.now() / 1000)}`;

      const payload = {
        internal_name: (p.internal_name || "Landing sin título") + " (copia)",
        slug: newSlug,
        wa_message: p.wa_message ?? null,
        meta_pixel_id: p.meta_pixel_id ?? null,
        meta_access_token: p.meta_access_token ?? null,
        content: p.content,
      };

      const res = await fetch("/api/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const json = await res.json();

      if (!res.ok) {
        throw new Error(json?.error || "No se pudo duplicar la página.");
      }

      const newPage = json.page as LandingRow;
      setPages((prev) => [newPage, ...prev]);
    } catch (err: any) {
      console.error(err);
      alert(err.message || "No se pudo duplicar la página.");
    } finally {
      setMenuOpenId(null);
    }
  };

  // ELIMINAR usando DELETE /api/pages/[id]
  const handleDelete = async (p: LandingRow) => {
    const ok = confirm(
      `¿Eliminar la landing "${p.internal_name || "Landing sin título"}"?`
    );
    if (!ok) return;

    try {
      const res = await fetch(`/api/pages/${p.id}`, {
        method: "DELETE",
      });

      const json = await res.json();

      if (!res.ok || json?.ok === false) {
        throw new Error(json?.error || "No se pudo eliminar la página.");
      }

      setPages((prev) => prev.filter((x) => x.id !== p.id));
    } catch (err: any) {
      console.error(err);
      alert(err.message || "No se pudo eliminar la página.");
    } finally {
      setMenuOpenId(null);
    }
  };

  /* ============ UI ============ */

  return (
    <main className="min-h-screen bg-[#050816] text-white px-8 py-6">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold">Páginas</h1>
          <p className="text-xs text-white/60">
            Administrá todas las landings que creaste para tus campañas.
          </p>
        </div>

        <Link
          href="/pages/editor"
          className="rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-black hover:bg-emerald-400"
        >
          + Crear página
        </Link>
      </header>

      {error && (
        <div className="mb-4 rounded border border-red-500/40 bg-red-950/40 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {loading ? (
        <p className="text-sm text-white/70">Cargando páginas…</p>
      ) : pages.length === 0 ? (
        <div className="mt-10 text-sm text-white/60">
          Todavía no creaste ninguna landing.{" "}
          <Link href="/pages/editor" className="text-emerald-400 underline">
            Crear la primera
          </Link>
        </div>
      ) : (
        <section className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {pages.map((p) => {
            const content = (p.content || {}) as any;
            const thumbBg: string | undefined = content.bgImageUrl;
            const title: string =
              content.title ||
              p.internal_name ||
              p.slug ||
              "Landing sin título";

            return (
              <article
                key={p.id}
                className="relative group rounded-xl border border-white/10 bg-black/40 shadow hover:border-emerald-400/60 hover:shadow-emerald-500/20 transition-all overflow-hidden"
              >
                {/* Zona clickeable para EDITAR */}
                <button
                  type="button"
                  onClick={() => handleEdit(p)}
                  className="relative z-0 w-full text-left"
                >
                  <div className="h-40 w-full relative">
                    {thumbBg ? (
                      <div
                        className="absolute inset-0 bg-cover bg-center"
                        style={{ backgroundImage: `url(${thumbBg})` }}
                      />
                    ) : (
                      <div className="absolute inset-0 bg-gradient-to-br from-emerald-700 via-slate-900 to-indigo-900" />
                    )}
                    <div className="absolute inset-0 bg-black/55" />
                    <div className="relative z-10 flex h-full flex-col items-center justify-center px-4 text-center gap-2">
                      <p className="text-xs font-semibold text-emerald-200 tracking-wide">
                        Vista previa
                      </p>
                      <p className="text-sm font-bold line-clamp-2">{title}</p>
                      <div className="mt-1 inline-flex items-center gap-2 rounded-full bg-black/60 px-3 py-1 text-[11px] text-white/70">
                        <span className="inline-block h-2 w-2 rounded-full bg-emerald-400" />
                        <span>Ir al WhatsApp ahora</span>
                      </div>
                    </div>
                  </div>

                  <div className="border-t border-white/10 px-4 py-3 text-xs">
                    <p className="font-semibold truncate group-hover:text-emerald-300">
                      {p.internal_name || "Landing sin título"}
                    </p>
                    <p className="text-white/50 truncate">
                      URL: <code>/p/{p.slug || "…"}</code>
                    </p>
                  </div>
                </button>

                {/* Botón 3 puntitos + menú */}
                <div className="absolute top-2 right-2 z-20">
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      toggleMenu(p.id);
                    }}
                    className="cursor-pointer rounded-full bg-black/60 p-1.5 border border-white/20 hover:bg-black/80"
                  >
                    <span className="block h-4 w-4 text-center leading-4 text-white/80">
                      ⋮
                    </span>
                  </button>

                  {menuOpenId === p.id && (
                    <div
                      className="mt-2 w-40 rounded-md bg-[#050816] border border-white/15 shadow-xl text-xs overflow-hidden"
                      onClick={(e) => {
                        e.stopPropagation();
                        e.preventDefault();
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => handleVisit(p)}
                        className="w-full px-3 py-2 text-left hover:bg-white/5 flex items-center gap-2"
                      >
                        <span>↗️</span>
                        <span>Visitar</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleEdit(p)}
                        className="w-full px-3 py-2 text-left hover:bg-white/5 flex items-center gap-2"
                      >
                        <span>✏️</span>
                        <span>Editar página</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDuplicate(p)}
                        className="w-full px-3 py-2 text-left hover:bg-white/5 flex items-center gap-2"
                      >
                        <span>📄</span>
                        <span>Duplicar</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(p)}
                        className="w-full px-3 py-2 text-left hover:bg-red-500/10 text-red-400 flex items-center gap-2"
                      >
                        <span>🗑</span>
                        <span>Eliminar</span>
                      </button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </section>
      )}
    </main>
  );
}
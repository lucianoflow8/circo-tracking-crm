"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function LandingList() {
  const [pages, setPages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase
        .from("landing_pages")
        .select("*")
        .order("updated_at", { ascending: false });
      if (!error) setPages(data || []);
      setLoading(false);
    };
    load();
  }, []);

  return (
    <main className="min-h-screen bg-[#050816] text-white p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Páginas</h1>
        <Link
          href="/landing/new"
          className="bg-emerald-500 hover:bg-emerald-400 text-black text-sm font-medium px-4 py-2 rounded-md"
        >
          ➕ Crear página
        </Link>
      </div>

      {loading ? (
        <p className="text-white/60 text-sm">Cargando páginas...</p>
      ) : pages.length === 0 ? (
        <p className="text-white/50 text-sm">Aún no hay páginas creadas.</p>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-6">
          {pages.map((p) => (
            <div
              key={p.id}
              className="rounded-xl bg-black/50 border border-white/10 hover:border-emerald-400/50 transition-all overflow-hidden"
            >
              {p.content?.bgImageUrl ? (
                <div
                  className="h-40 bg-cover bg-center"
                  style={{ backgroundImage: `url(${p.content.bgImageUrl})` }}
                />
              ) : (
                <div className="h-40 bg-gradient-to-br from-emerald-700 via-slate-900 to-indigo-900" />
              )}

              <div className="p-4 space-y-1">
                <h2 className="font-semibold text-sm truncate">
                  {p.internal_name || "Sin título"}
                </h2>
                <p className="text-[12px] text-white/60 truncate">
                  {p.slug ? `/p/${p.slug}` : "(sin slug)"}
                </p>

                <div className="flex justify-between mt-3">
                  <Link
                    href={`/landing/${p.id}/edit`}
                    className="text-xs bg-emerald-500 hover:bg-emerald-400 text-black px-3 py-1 rounded-md"
                  >
                    Editar
                  </Link>
                  <a
                    href={`/p/${p.slug}`}
                    target="_blank"
                    className="text-xs text-emerald-400 hover:underline"
                  >
                    Ver pública
                  </a>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

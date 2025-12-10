"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { supabase } from "@/lib/supabaseClient";

export default function NewLanding() {
  const router = useRouter();

  useEffect(() => {
    const create = async () => {
      const { data, error } = await supabase
        .from("landing_pages")
        .insert({
          internal_name: "Nueva página",
          slug: `page-${Date.now()}`,
          content: {},
        })
        .select("id")
        .single();

      if (!error && data?.id) router.push(`/landing/${data.id}/edit`);
    };
    create();
  }, [router]);

  return (
    <main className="min-h-screen flex items-center justify-center text-white bg-[#050816]">
      <p>Creando nueva página...</p>
    </main>
  );
}

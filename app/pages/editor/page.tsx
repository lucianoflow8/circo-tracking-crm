// app/pages/editor/page.tsx
import { Suspense } from "react";
import EditorPageClient from "./EditorPageClient";

export default function EditorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-[calc(100vh-56px)] items-center justify-center bg-[#050816] text-xs text-white/60">
          Cargando editor…
        </div>
      }
    >
      <EditorPageClient />
    </Suspense>
  );
}
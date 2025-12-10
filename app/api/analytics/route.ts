// app/api/analytics/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUserId } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// Cliente server-side
const supabase = createClient(supabaseUrl, supabaseAnonKey);

type LandingPageRow = {
  id: string;
  internal_name: string | null;
  slug: string | null;
  created_at: string | null;
};

type LandingEventRow = {
  landing_id: string;
  event_type: string;
  created_at: string | null;
  amount: number | null;
  wa_phone: string | null; // 👈 importante para deduplicar por número
};

type AnalyticsPoint = {
  date: string; // YYYY-MM-DD
  landingId: string;
  pageName: string;
  visits: number;
  clicks: number;
  chats: number;       // chats únicos (wa_phone)
  conversions: number; // conversiones únicas (wa_phone)
  revenue: number;
};

type AnalyticsApiResponse = {
  pages: { id: string; name: string }[];
  points: AnalyticsPoint[];
  error?: string;
};

export async function GET(req: NextRequest) {
  try {
    // 👤 dueño actual
    const currentUserId = await getCurrentUserId();
    if (!currentUserId) {
      const resp: AnalyticsApiResponse = {
        pages: [],
        points: [],
        error: "No autenticado",
      };
      return NextResponse.json(resp, { status: 401 });
    }

    const url = new URL(req.url);
    const from = url.searchParams.get("from"); // YYYY-MM-DD (opcional)
    const to = url.searchParams.get("to"); // YYYY-MM-DD (opcional)
    const landingIdFilter = url.searchParams.get("landingId"); // id o "all"

    // 1) Traer SOLO las landing_pages del owner actual
    const { data: landingPages, error: lpError } = await supabase
      .from("landing_pages")
      .select("id, internal_name, slug, created_at")
      .eq("owner_id", currentUserId) // 👈 solo mis landings
      .order("created_at", { ascending: true });

    if (lpError) {
      console.error("[API/ANALYTICS] Error landing_pages:", lpError);
      const resp: AnalyticsApiResponse = {
        pages: [],
        points: [],
        error: "No se pudieron cargar las páginas",
      };
      return NextResponse.json(resp, { status: 200 });
    }

    const landingPageRows = (landingPages || []) as LandingPageRow[];

    if (landingPageRows.length === 0) {
      const resp: AnalyticsApiResponse = {
        pages: [],
        points: [],
      };
      return NextResponse.json(resp, { status: 200 });
    }

    const pageMap = new Map<string, string>();
    for (const lp of landingPageRows) {
      const name =
        lp.internal_name || lp.slug || `Landing ${lp.id.slice(0, 8)}`;
      pageMap.set(lp.id, name);
    }

    const landingIds = landingPageRows.map((lp) => lp.id);

    // 2) Traer eventos de landing_events SOLO de mis landings
    let eventsQuery = supabase
      .from("landing_events")
      .select("landing_id, event_type, amount, created_at, wa_phone")
      .in("landing_id", landingIds);

    if (from) {
      eventsQuery = eventsQuery.gte("created_at", `${from}T00:00:00`);
    }
    if (to) {
      eventsQuery = eventsQuery.lte("created_at", `${to}T23:59:59`);
    }
    if (landingIdFilter && landingIdFilter !== "all") {
      eventsQuery = eventsQuery.eq("landing_id", landingIdFilter);
    }

    const { data: events, error: evError } = await eventsQuery;

    if (evError) {
      console.error("[API/ANALYTICS] Error landing_events:", evError);
      const resp: AnalyticsApiResponse = {
        pages: landingPageRows.map((lp) => ({
          id: lp.id,
          name:
            lp.internal_name || lp.slug || `Landing ${lp.id.slice(0, 8)}`,
        })),
        points: [],
        error: "No se pudieron cargar los eventos",
      };
      return NextResponse.json(resp, { status: 200 });
    }

    const eventRows = (events || []) as LandingEventRow[];

    // ⚠️ Ordenamos por fecha ascendente para que "la primera vez"
    // que aparece un número defina el día donde cuenta el chat/conversión
    eventRows.sort((a, b) => {
      const da = a.created_at || "";
      const db = b.created_at || "";
      return da.localeCompare(db);
    });

    // 3) Agrupar por fecha + landing_id
    const map = new Map<string, AnalyticsPoint>();

    // Sets GLOBAL por landing → 1 chat / 1 conversion máximo por número
    const globalChatPhones = new Map<string, Set<string>>(); // landingId -> set phones
    const globalConvPhones = new Map<string, Set<string>>(); // landingId -> set phones

    const ensureGlobalSet = (
      store: Map<string, Set<string>>,
      landingId: string
    ) => {
      if (!store.has(landingId)) {
        store.set(landingId, new Set<string>());
      }
      return store.get(landingId)!;
    };

    for (const row of eventRows) {
      if (!row.created_at) continue;
      const date = row.created_at.slice(0, 10); // YYYY-MM-DD
      const landingId = row.landing_id;
      const pageName =
        pageMap.get(landingId) || `Landing ${landingId.slice(0, 8)}`;

      const key = `${date}_${landingId}`;

      if (!map.has(key)) {
        map.set(key, {
          date,
          landingId,
          pageName,
          visits: 0,
          clicks: 0,
          chats: 0,
          conversions: 0,
          revenue: 0,
        });
      }

      const p = map.get(key)!;
      const phone = row.wa_phone?.trim() || null;

      switch (row.event_type) {
        case "visit":
        case "view":
          p.visits += 1;
          break;

        case "click":
          p.clicks += 1;
          break;

        case "chat": {
          if (phone) {
            const set = ensureGlobalSet(globalChatPhones, landingId);
            const before = set.size;
            set.add(phone);
            // solo sumamos si es la primera vez que ese número chatea en esa landing
            if (set.size > before) {
              p.chats += 1;
            }
          } else {
            // fallback si no tenemos teléfono
            p.chats += 1;
          }
          break;
        }

        case "conversion": {
          // siempre sumamos revenue
          const amt =
            typeof row.amount === "number" && !Number.isNaN(row.amount)
              ? row.amount
              : 0;
          p.revenue += amt;

          if (phone) {
            const set = ensureGlobalSet(globalConvPhones, landingId);
            const before = set.size;
            set.add(phone);
            // solo sumamos si es la primera vez que este número convierte en esa landing
            if (set.size > before) {
              p.conversions += 1;
            }
          } else {
            // fallback si no vino teléfono
            p.conversions += 1;
          }
          break;
        }

        default:
          break;
      }
    }

    const points = Array.from(map.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    const response: AnalyticsApiResponse = {
      pages: landingPageRows.map((lp) => ({
        id: lp.id,
        name:
          lp.internal_name || lp.slug || `Landing ${lp.id.slice(0, 8)}`,
      })),
      points,
    };

    return NextResponse.json(response, { status: 200 });
  } catch (e: any) {
    console.error("[API/ANALYTICS] Excepción:", e);
    const resp: AnalyticsApiResponse = {
      pages: [],
      points: [],
      error: "Error interno en el endpoint de analytics",
    };
    return NextResponse.json(resp, { status: 200 });
  }
}

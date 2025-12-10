// app/api/dashboard-summary/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getCurrentUserId } from "@/lib/auth";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

type ChatEventRow = {
  wa_phone: string | null;
};

type ConversionEventRow = {
  wa_phone: string | null;
  amount: number | null;
};

// helper: deja solo dígitos para evitar duplicados por formato
function toDigits(phone: string | null | undefined): string {
  if (!phone) return "";
  return phone.replace(/\D/g, "");
}

export async function GET(_req: NextRequest) {
  try {
    // 👤 usuario actual
    const userId = await getCurrentUserId();
    if (!userId) {
      return NextResponse.json(
        {
          totalContacts: 0,
          totalConversions: 0,
          totalRevenue: 0,
          error: "No autenticado",
        },
        { status: 200 }
      );
    }

    // 1) Landings que pertenecen a este usuario
    const { data: landingPages, error: lpError } = await supabase
      .from("landing_pages")
      .select("id")
      .eq("owner_id", userId);

    if (lpError) {
      console.error("[API/DASHBOARD] Error landing_pages:", lpError);
      return NextResponse.json(
        {
          totalContacts: 0,
          totalConversions: 0,
          totalRevenue: 0,
          error: "Error cargando landings",
        },
        { status: 200 }
      );
    }

    const landingIds = (landingPages ?? []).map((lp: any) => lp.id as string);

    // Si el usuario no tiene landings → todo en 0
    if (landingIds.length === 0) {
      return NextResponse.json(
        {
          totalContacts: 0,
          totalConversions: 0,
          totalRevenue: 0,
        },
        { status: 200 }
      );
    }

    // === CONTACTOS: eventos "chat" sólo de MIS landings ===
    const { data: chatEvents, error: chatError } = await supabase
      .from("landing_events")
      .select("wa_phone, landing_id")
      .eq("event_type", "chat")
      .in("landing_id", landingIds);

    if (chatError) {
      console.error("[API/DASHBOARD] Error chatEvents:", chatError);
    }

    const chatRows = (chatEvents || []) as ChatEventRow[];

    const phoneSet = new Set<string>();
    for (const row of chatRows) {
      const digits = toDigits(row.wa_phone);
      if (digits) {
        phoneSet.add(digits);
      }
    }
    const totalContacts = phoneSet.size;

    // === CONVERSIONES: eventos "conversion" sólo de MIS landings ===
    const { data: convEvents, error: convError } = await supabase
      .from("landing_events")
      .select("wa_phone, amount, landing_id")
      .eq("event_type", "conversion")
      .in("landing_id", landingIds);

    if (convError) {
      console.error("[API/DASHBOARD] Error convEvents:", convError);
    }

    const convRows = (convEvents || []) as ConversionEventRow[];

    // 👉 1 conversión POR TELÉFONO (como en contactos)
    const convPhoneSet = new Set<string>();
    let totalRevenue = 0;

    for (const row of convRows) {
      const digits = toDigits(row.wa_phone);
      if (digits) {
        convPhoneSet.add(digits);
      }

      const amt = typeof row.amount === "number" ? row.amount : 0;
      totalRevenue += amt;
    }

    const totalConversions = convPhoneSet.size;

    return NextResponse.json(
      {
        totalContacts,
        totalConversions,
        totalRevenue,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error("[API/DASHBOARD] Excepción:", e);
    return NextResponse.json(
      {
        totalContacts: 0,
        totalConversions: 0,
        totalRevenue: 0,
        error: "Error interno en el resumen del dashboard",
      },
      { status: 200 }
    );
  }
}
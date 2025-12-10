// app/api/contacts/route.ts
import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { createClient } from '@supabase/supabase-js';

// ===== Supabase para contactos agregados (landing_events) =====
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

const supabase =
  supabaseUrl && supabaseAnonKey
    ? createClient(supabaseUrl, supabaseAnonKey)
    : null;

// línea de WhatsApp por defecto (la que usás hoy)
const DEFAULT_LINE_ID = process.env.WA_DEFAULT_LINE_ID || null;

type LandingEventRow = {
  landing_id: string | null;
  wa_phone: string | null;
  event_type: string;
  amount: number | null;
  created_at: string | null;
};

type AggregatedBase = {
  phone: string;
  totalChats: number;        // ahora se va a usar como 0 ó 1
  totalConversions: number;  // ahora se va a usar como 0 ó 1
  totalAmount: number;
  firstChatAt: string | null;
  lastChatAt: string | null;
  lastEventAt: string | null;
  lastLandingId: string | null;
  // flags internos para no contar más de una vez
  hasChat: boolean;
  hasConversion: boolean;
};

type AggregatedContactResponse = AggregatedBase & {
  lineId: string | null;
  lineLabel: string | null;
  displayName: string | null;
  avatarUrl: string | null;
};

type LineOption = {
  id: string;
  label: string;
};

// helper: deja solo dígitos
function toDigits(phone: string | null | undefined): string {
  if (!phone) return '';
  return phone.replace(/\D/g, '');
}

// GET /api/contacts?lineId=XXX  → lista contactos de una línea (CRM, Prisma)
// GET /api/contacts             → lista agregada de contactos (landing_events)
export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const lineIdParam = searchParams.get('lineId');

    // ====== RAMA 1: comportamiento anterior (por línea, Prisma) ======
    if (lineIdParam) {
      const contacts = await prisma.contact.findMany({
        where: { whatsappLineId: lineIdParam },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          phone: true,
          name: true,
          firstContactAt: true,
          lastMessageAt: true,
          totalMessages: true,
          createdAt: true,
        },
      });

      return NextResponse.json({ contacts });
    }

    // ====== RAMA 2: lista agregada para /contactos ======
    if (!supabase) {
      console.error('[API/CONTACTS] Supabase no configurado');
      return NextResponse.json(
        {
          contacts: [] as AggregatedContactResponse[],
          lines: [] as LineOption[],
          error: 'Supabase no está configurado en el servidor',
        },
        { status: 200 }
      );
    }

    const { data, error } = await supabase
      .from('landing_events')
      .select('landing_id, wa_phone, event_type, amount, created_at')
      .not('wa_phone', 'is', null);

    if (error) {
      console.error('[API/CONTACTS] Error landing_events:', error);
      return NextResponse.json(
        {
          contacts: [] as AggregatedContactResponse[],
          lines: [] as LineOption[],
          error: 'No se pudieron cargar los contactos',
        },
        { status: 200 }
      );
    }

    const rows = (data || []) as LandingEventRow[];

    // 1) Agrupar por teléfono (base desde Supabase)
    const map = new Map<string, AggregatedBase>();

    for (const row of rows) {
      if (!row.wa_phone) continue;

      const phoneDigits = toDigits(row.wa_phone);
      if (!phoneDigits) continue;

      if (!map.has(phoneDigits)) {
        map.set(phoneDigits, {
          phone: phoneDigits,
          totalChats: 0,
          totalConversions: 0,
          totalAmount: 0,
          firstChatAt: null,
          lastChatAt: null,
          lastEventAt: null,
          lastLandingId: null,
          hasChat: false,
          hasConversion: false,
        });
      }

      const contact = map.get(phoneDigits)!;
      const ts = row.created_at ?? null;

      // último evento para ordenar
      if (ts && (!contact.lastEventAt || ts.localeCompare(contact.lastEventAt) > 0)) {
        contact.lastEventAt = ts;
        contact.lastLandingId = row.landing_id ?? null;
      }

      // chats → SOLO marcamos 1 por número
      if (row.event_type === 'chat') {
        if (!contact.hasChat) {
          contact.totalChats = 1;   // 👈 siempre 0 ó 1
          contact.hasChat = true;
        }

        if (!contact.firstChatAt || (ts && ts < contact.firstChatAt)) {
          contact.firstChatAt = ts;
        }
        if (!contact.lastChatAt || (ts && ts > contact.lastChatAt)) {
          contact.lastChatAt = ts;
        }
      }

      // conversiones → SOLO marcamos 1 por número, pero sumamos TODO el monto
      if (row.event_type === 'conversion') {
        if (!contact.hasConversion) {
          contact.totalConversions = 1;  // 👈 siempre 0 ó 1
          contact.hasConversion = true;
        }

        const amt = typeof row.amount === 'number' ? row.amount : 0;
        contact.totalAmount += amt;
      }
    }

    let aggregated = Array.from(map.values()).sort((a, b) => {
      const aTs = a.lastEventAt ?? '';
      const bTs = b.lastEventAt ?? '';
      return bTs.localeCompare(aTs);
    });

    // 2) Línea por defecto desde Prisma
    let defaultLineLabel: string | null = null;
    let defaultLineOption: LineOption | null = null;

    if (DEFAULT_LINE_ID) {
      try {
        const line = await prisma.whatsappLine.findUnique({
          where: { id: DEFAULT_LINE_ID },
          select: { id: true, name: true, phoneNumber: true },
        });

        defaultLineLabel =
          line?.name || line?.phoneNumber || 'Línea principal';

        defaultLineOption = {
          id: DEFAULT_LINE_ID,
          label: defaultLineLabel,
        };
      } catch (e) {
        console.error('[API/CONTACTS] Error leyendo whatsappLine:', e);
      }
    }

    // 3) Traer perfiles cacheados (nombre + avatar) desde PhoneProfile
    const phones = aggregated.map((c) => c.phone);
    const profiles = await prisma.phoneProfile.findMany({
      where: { phone: { in: phones } },
    });

    const profileMap = new Map<
      string,
      { name: string | null; avatarUrl: string | null }
    >();
    for (const p of profiles) {
      profileMap.set(p.phone, {
        name: p.name ?? null,
        avatarUrl: p.avatarUrl ?? null,
      });
    }

    // 4) Armar respuesta final
    const contacts: AggregatedContactResponse[] = aggregated.map((c) => {
      const p = profileMap.get(c.phone);
      return {
        ...c,
        lineId: DEFAULT_LINE_ID,
        lineLabel: defaultLineLabel,
        displayName: p?.name ?? null,
        avatarUrl: p?.avatarUrl ?? null,
      };
    });

    return NextResponse.json(
      {
        contacts,
        lines: defaultLineOption ? [defaultLineOption] : [],
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('GET /contacts error', error);
    return NextResponse.json(
      { contacts: [], lines: [], error: 'Error al obtener contactos' },
      { status: 500 }
    );
  }
}

// POST /api/contacts  → crea contacto manual para una línea (SIN CAMBIOS)
export async function POST(req: Request) {
  try {
    const { lineId, phone, name } = await req.json();

    if (!lineId || !phone) {
      return NextResponse.json(
        { error: 'Faltan lineId o phone' },
        { status: 400 }
      );
    }

    const line = await prisma.whatsappLine.findUnique({
      where: { id: lineId },
    });

    if (!line) {
      return NextResponse.json(
        { error: 'Línea no encontrada' },
        { status: 404 }
      );
    }

    const now = new Date();

    const contact = await prisma.contact.create({
      data: {
        whatsappLineId: lineId,
        phone,
        name: name || null,
        firstContactAt: now,
        lastMessageAt: now,
        totalMessages: 0,
      },
      select: {
        id: true,
        phone: true,
        name: true,
        firstContactAt: true,
        lastMessageAt: true,
        totalMessages: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ contact }, { status: 201 });
  } catch (error) {
    console.error('POST /contacts error', error);
    return NextResponse.json(
      { error: 'Error al crear contacto' },
      { status: 500 }
    );
  }
}
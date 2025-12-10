// app/api/contact-conversions/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('[API/CONTACT-CONVERSIONS] Falta configurar SUPABASE_URL o ANON_KEY');
}

const supabase =
  supabaseUrl && supabaseAnonKey ? createClient(supabaseUrl, supabaseAnonKey) : null;

// Debe coincidir con las columnas reales de landing_events
type LandingConversionRow = {
  id: string;
  wa_phone: string | null;
  event_type: string;
  amount: number | null;
  created_at: string | null;
  screenshot_url?: string | null; // 👈 URL de la imagen del comprobante
};

// GET /api/contact-conversions?phone=54911...
export async function GET(req: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { conversions: [], error: 'Supabase no está configurado en el servidor' },
        { status: 200 }
      );
    }

    const { searchParams } = new URL(req.url);
    const phone = searchParams.get('phone');

    if (!phone) {
      return NextResponse.json(
        { conversions: [], error: 'Falta parámetro "phone"' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('landing_events')
      .select('id, wa_phone, event_type, amount, created_at, screenshot_url')
      .eq('wa_phone', phone)
      .eq('event_type', 'conversion')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[API/CONTACT-CONVERSIONS] Error Supabase:', error);
      return NextResponse.json(
        { conversions: [], error: 'No se pudieron cargar los comprobantes' },
        { status: 200 }
      );
    }

    return NextResponse.json({
      conversions: (data || []) as LandingConversionRow[],
    });
  } catch (e) {
    console.error('[API/CONTACT-CONVERSIONS] Excepción:', e);
    return NextResponse.json(
      { conversions: [], error: 'Error interno al cargar comprobantes' },
      { status: 500 }
    );
  }
}

// DELETE /api/contact-conversions?id=xxxxx
export async function DELETE(req: NextRequest) {
  try {
    if (!supabase) {
      return NextResponse.json(
        { success: false, error: 'Supabase no está configurado en el servidor' },
        { status: 200 }
      );
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json(
        { success: false, error: 'Falta parámetro "id"' },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from('landing_events')
      .delete()
      .eq('id', id)
      .eq('event_type', 'conversion')
      .select('amount, wa_phone')
      .single();

    if (error) {
      console.error('[API/CONTACT-CONVERSIONS] Error DELETE:', error);
      return NextResponse.json(
        { success: false, error: 'No se pudo eliminar el comprobante' },
        { status: 200 }
      );
    }

    const amount = typeof data?.amount === 'number' ? data.amount : 0;

    return NextResponse.json({
      success: true,
      amount,
      phone: data?.wa_phone ?? null,
    });
  } catch (e) {
    console.error('[API/CONTACT-CONVERSIONS] Excepción DELETE:', e);
    return NextResponse.json(
      { success: false, error: 'Error interno al eliminar comprobante' },
      { status: 500 }
    );
  }
}

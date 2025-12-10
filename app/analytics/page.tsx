'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';

type AnalyticsPageMeta = {
  id: string;
  name: string;
};

type AnalyticsPoint = {
  date: string;        // YYYY-MM-DD
  landingId: string;
  pageName: string;
  visits: number;
  clicks: number;
  chats: number;
  conversions: number;
  revenue: number;
};

type AnalyticsApiResponse = {
  pages: AnalyticsPageMeta[];
  points: AnalyticsPoint[];
  error?: string;
};

// Helper para porcentajes
const getRate = (num: number, denom: number) =>
  denom > 0 ? ((num / denom) * 100).toFixed(1) : '0.0';

export default function AnalyticsPage() {
  const [pages, setPages] = useState<AnalyticsPageMeta[]>([]);
  const [selectedLandingId, setSelectedLandingId] = useState<'all' | string>('all');

  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  const [analyticsData, setAnalyticsData] = useState<AnalyticsPoint[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  // ==== Carga inicial de datos desde /api/analytics ====
  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch('/api/analytics');

        if (!res.ok) {
          const text = await res.text();
          console.error('Analytics API error', res.status, text);
          setError('No se pudieron cargar las estadísticas');
          setAnalyticsData([]);
          setPages([]);
          setLoading(false);
          return;
        }

        const json: AnalyticsApiResponse = await res.json();

        if (json.error) {
          console.error('Analytics API logical error:', json.error);
          setError(json.error);
        }

        setPages(json.pages || []);
        setAnalyticsData(json.points || []);

        if (json.points && json.points.length > 0) {
          const sorted = [...json.points].sort((a, b) =>
            a.date.localeCompare(b.date)
          );
          setFromDate(sorted[0].date);
          setToDate(sorted[sorted.length - 1].date);
        } else {
          setFromDate('');
          setToDate('');
        }
      } catch (e: any) {
        console.error(e);
        setError(e?.message || 'Error desconocido al cargar analytics');
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
  }, []);

  // Nombre que se muestra en el título
  const selectedPageName = useMemo(() => {
    if (selectedLandingId === 'all') return 'Todas las páginas';
    const page = pages.find((p) => p.id === selectedLandingId);
    return page?.name || 'Página sin nombre';
  }, [selectedLandingId, pages]);

  // Filtrado por landing en el front
  const filteredData = useMemo(() => {
    let data = analyticsData;

    if (selectedLandingId !== 'all') {
      data = data.filter((d) => d.landingId === selectedLandingId);
    }

    return data;
  }, [analyticsData, selectedLandingId]);

  // Totales para las tarjetas + embudo
  const totals = useMemo(() => {
    return filteredData.reduce(
      (acc, d) => {
        acc.visits += d.visits;
        acc.clicks += d.clicks;
        acc.chats += d.chats;
        acc.conversions += d.conversions;
        acc.revenue += d.revenue;
        return acc;
      },
      { visits: 0, clicks: 0, chats: 0, conversions: 0, revenue: 0 }
    );
  }, [filteredData]);

  const rateVisitToClick = getRate(totals.clicks, totals.visits);
  const rateClickToChat = getRate(totals.chats, totals.clicks);
  const rateChatToConv = getRate(totals.conversions, totals.chats);

  return (
    <main className="ct-page ct-analytics-page">
      {/* Header */}
      <header className="ct-dashboard-header">
  <div>
    <h1
      className="ct-dashboard-title"
      style={{ color: '#f9fafb' }}   // 👈 forzamos blanco
    >
      Analytics
    </h1>
    <p className="ct-dashboard-subtitle">
      Visualizá el rendimiento de tus páginas y líneas: vistas, clics al botón,
      chats iniciados y conversiones. Filtrá por página y rango de fechas para ver
      qué está funcionando mejor.
    </p>
    

          {loading && (
            <p className="text-sm text-slate-400 mt-2">
              Cargando estadísticas en base a tus píxeles...
            </p>
          )}

          {error && (
            <p className="text-sm text-red-400 mt-2">
              Ocurrió un problema al cargar tus estadísticas.
            </p>
          )}
        </div>

        <Link href="/dashboard" className="ct-dashboard-main-btn">
          ← Volver al dashboard
        </Link>
      </header>

      {/* Filtros */}
      <section className="ct-analytics-filters">
        <div className="ct-filter-group">
          <label className="ct-filter-label">Página</label>
          <select
            className="ct-filter-select"
            value={selectedLandingId}
            onChange={(e) =>
              setSelectedLandingId(e.target.value === 'all' ? 'all' : e.target.value)
            }
          >
            <option value="all">Todas las páginas</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="ct-filter-group">
          <label className="ct-filter-label">Desde</label>
          <input
            type="date"
            className="ct-filter-input"
            value={fromDate}
            readOnly
          />
        </div>

        <div className="ct-filter-group">
          <label className="ct-filter-label">Hasta</label>
          <input
            type="date"
            className="ct-filter-input"
            value={toDate}
            readOnly
          />
        </div>
      </section>

      {/* KPIs arriba */}
      <section className="ct-analytics-kpi-grid">
        <div className="ct-analytics-kpi-card">
          <p className="ct-summary-label">Visitas de página</p>
          <p className="ct-summary-value">{totals.visits}</p>
        </div>

        <div className="ct-analytics-kpi-card">
          <p className="ct-summary-label">Clicks al botón</p>
          <p className="ct-summary-value">{totals.clicks}</p>
        </div>

        <div className="ct-analytics-kpi-card">
          <p className="ct-summary-label">Chats</p>
          <p className="ct-summary-value">{totals.chats}</p>
        </div>

        {/* 🔥 Card de conversiones alineada con las otras */}
        <div className="ct-analytics-kpi-card ct-analytics-kpi-card-revenue">
          <p className="ct-summary-label">Conversiones</p>
          {/* número blanco alineado igual que las otras */}
          <p className="ct-summary-value">{totals.conversions}</p>

          {/* chip verde debajo, a la derecha */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: '0.4rem',
            }}
          >
            <span
              className="ct-analytics-kpi-chip"
              style={{
                fontSize: '1.1rem',
                paddingInline: '0.85rem',
                paddingBlock: '0.35rem',
              }}
            >
              ${totals.revenue.toLocaleString('es-AR')}
            </span>
          </div>
        </div>
      </section>

      {/* Gráfico principal */}
      <section className="ct-analytics-chart-card">
        <div className="ct-analytics-chart-header">
          <h2
            className="ct-card-title"
            style={{ color: '#e5e7eb' }}
          >
            Analytics · Página:{' '}
            <span
              className="ct-analytics-page-name"
              style={{ color: '#fb923c' }}
            >
              {selectedPageName}
            </span>
          </h2>
          <p className="ct-analytics-chart-helper">
            Eje izquierdo: cantidad de conversiones · Eje derecho: monto recibido por
            comprobante · Eje horizontal: fechas.
          </p>
        </div>

        <div className="ct-analytics-chart-wrapper">
          <ResponsiveContainer width="100%" height={340}>
            <LineChart data={filteredData}>
              <defs>
                <linearGradient id="convLine" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#60a5fa" />
                  <stop offset="100%" stopColor="#a855f7" />
                </linearGradient>
                <linearGradient id="revLine" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor="#22c55e" />
                  <stop offset="100%" stopColor="#06b6d4" />
                </linearGradient>
              </defs>

              <CartesianGrid stroke="#111827" vertical={false} />
              <XAxis dataKey="date" stroke="#6b7280" />
              {/* Eje izquierdo: conversiones */}
              <YAxis
                yAxisId="left"
                stroke="#60a5fa"
                tickFormatter={(v) => v.toString()}
              />
              {/* Eje derecho: ingresos */}
              <YAxis
                yAxisId="right"
                orientation="right"
                stroke="#22c55e"
                tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`}
              />
              <Tooltip
                contentStyle={{
                  background: '#020617',
                  border: '1px solid #111827',
                  borderRadius: 12,
                  color: '#e5e7eb',
                }}
                labelStyle={{
                  color: '#e5e7eb',
                  fontWeight: 600,
                }}
                itemStyle={{
                  color: '#e5e7eb',
                }}
                formatter={(value, name) => {
                  if (name === 'Ingresos') {
                    return [`$ ${Number(value).toLocaleString('es-AR')}`, 'Ingresos'];
                  }
                  return [value, name];
                }}
              />
              <Line
                type="monotone"
                dataKey="conversions"
                name="Conversiones"
                stroke="url(#convLine)"
                strokeWidth={2.4}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                yAxisId="left"
              />
              <Line
                type="monotone"
                dataKey="revenue"
                name="Ingresos"
                stroke="url(#revLine)"
                strokeWidth={2.4}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
                yAxisId="right"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="ct-analytics-chart-legend">
          <span className="ct-legend-dot ct-legend-dot-blue" />
          Conversiones
          <span className="ct-legend-dot ct-legend-dot-green" />
          Ingresos
        </div>
      </section>

      {/* ===== Embudo de conversión ===== */}
      <section className="ct-analytics-funnel-card">
        <h2 className="ct-card-title">Embudo de conversión</h2>
        <p className="ct-analytics-chart-helper">
          Compará cuántas personas avanzan en cada paso: desde ver la página hasta
          enviar comprobante.
        </p>

        <div className="ct-analytics-funnel-grid">
          {/* Paso 1 */}
          <div className="ct-funnel-item">
            <p className="ct-funnel-label">Visitas → Click al botón</p>
            <p className="ct-funnel-values">
              <span>{totals.visits}</span>
              <span className="ct-funnel-arrow">→</span>
              <span>{totals.clicks}</span>
            </p>
            <p className="ct-funnel-rate">
              {rateVisitToClick}% de conversión
            </p>
          </div>

          {/* Paso 2 */}
          <div className="ct-funnel-item">
            <p className="ct-funnel-label">Click al botón → Chats</p>
            <p className="ct-funnel-values">
              <span>{totals.clicks}</span>
              <span className="ct-funnel-arrow">→</span>
              <span>{totals.chats}</span>
            </p>
            <p className="ct-funnel-rate">
              {rateClickToChat}% de conversión
            </p>
          </div>

          {/* Paso 3 */}
          <div className="ct-funnel-item">
            <p className="ct-funnel-label">Chats → Conversiones</p>
            <p className="ct-funnel-values">
              <span>{totals.chats}</span>
              <span className="ct-funnel-arrow">→</span>
              <span>{totals.conversions}</span>
            </p>
            <p className="ct-funnel-rate">
              {rateChatToConv}% de conversión
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}

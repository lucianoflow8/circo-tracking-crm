'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

type LineOption = {
  id: string;
  label: string;
};

type Contact = {
  phone: string;
  name?: string | null;
  totalChats: number;
  totalConversions: number;
  totalAmount: number;
  firstChatAt: string | null;
  lastChatAt: string | null;
  lastEventAt: string | null;
  lastLandingId: string | null;
  lineId?: string | null;
  lineLabel?: string | null;
  avatarUrl?: string | null;
};

type ContactsApiResponse = {
  contacts: Contact[];
  lines?: LineOption[];
  error?: string;
};

type ChatSummary = {
  id: string;
  name?: string;
  avatarUrl?: string;
  profilePicUrl?: string;
  photoUrl?: string;
};

type FilterKey = 'all' | 'chatsOnly' | 'conversions';

type ContactConversion = {
  id: string;
  amount: number | null;
  created_at: string | null;
  screenshot_url?: string | null;
};

const formatDateTime = (iso: string | null) => {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('es-AR');
  } catch {
    return iso;
  }
};

const getRate = (num: number, denom: number) =>
  denom > 0 ? ((num / denom) * 100).toFixed(1) : '0.0';

export default function ContactsPage() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [lines, setLines] = useState<LineOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filter, setFilter] = useState<FilterKey>('all');
  const [selectedLineId, setSelectedLineId] = useState<'all' | string>('all');

  const [fromDate, setFromDate] = useState<string>('');
  const [toDate, setToDate] = useState<string>('');

  // Panel lateral
  const [detailContact, setDetailContact] = useState<Contact | null>(null);
  const [detailConversions, setDetailConversions] = useState<ContactConversion[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  // copiar + zoom
  const [copiedPhone, setCopiedPhone] = useState(false);
  const [zoomImageUrl, setZoomImageUrl] = useState<string | null>(null);

  useEffect(() => {
    const fetchContactsAndAvatars = async () => {
      try {
        setLoading(true);
        setError(null);

        const [contactsRes, chatsRes] = await Promise.all([
          fetch('/api/contacts'),
          fetch('/api/chats').catch(() => null),
        ]);

        const contactsJson: ContactsApiResponse = await contactsRes.json();

        if (contactsJson.error) {
          setError(contactsJson.error);
        }

        let chats: ChatSummary[] = [];
        if (chatsRes && chatsRes.ok) {
          const chatsJson = await chatsRes.json();
          chats = (chatsJson.chats || []) as ChatSummary[];
        }

        // Map phone -> avatar desde WA server
        const avatarMap = new Map<string, string>();
        for (const ch of chats) {
          const jid = ch.id || '';
          const phoneKey = jid
            .replace(/@c\.us$/i, '')
            .replace(/@g\.us$/i, '');
          const avatar =
            ch.avatarUrl || ch.profilePicUrl || ch.photoUrl || '';
          if (phoneKey && avatar && !avatarMap.has(phoneKey)) {
            avatarMap.set(phoneKey, avatar);
          }
        }

        const contactsWithAvatars = (contactsJson.contacts || []).map((c) => ({
          ...c,
          avatarUrl: c.avatarUrl ?? avatarMap.get(c.phone) ?? null,
        }));

        setContacts(contactsWithAvatars);
        setLines(contactsJson.lines || []);

        // rango fechas por defecto
        if (contactsWithAvatars.length > 0) {
          const allDates = contactsWithAvatars
            .map((c) => c.firstChatAt || c.lastEventAt)
            .filter(Boolean) as string[];

          if (allDates.length > 0) {
            const sorted = [...allDates].sort();
            setFromDate(sorted[0].slice(0, 10));
            setToDate(sorted[sorted.length - 1].slice(0, 10));
          }
        }
      } catch (e: any) {
        console.error(e);
        setError(e?.message || 'Error al cargar contactos');
      } finally {
        setLoading(false);
      }
    };

    fetchContactsAndAvatars();
  }, []);

  const inDateRange = (c: Contact) => {
    if (!fromDate && !toDate) return true;
    const base = c.firstChatAt || c.lastEventAt;
    if (!base) return false;
    const d = base.slice(0, 10);

    if (fromDate && d < fromDate) return false;
    if (toDate && d > toDate) return false;
    return true;
  };

  const contactsForStats = useMemo(
    () =>
      contacts.filter((c) => {
        if (!inDateRange(c)) return false;
        if (selectedLineId !== 'all' && c.lineId !== selectedLineId) {
          return false;
        }
        return true;
      }),
    [contacts, fromDate, toDate, selectedLineId]
  );

  const stats = useMemo(() => {
    let chatsTotal = 0;
    let convTotal = 0;
    let revenueTotal = 0;

    for (const c of contactsForStats) {
      chatsTotal += c.totalChats;
      convTotal += c.totalConversions;
      revenueTotal += c.totalAmount;
    }

    return { chatsTotal, convTotal, revenueTotal };
  }, [contactsForStats]);

  const filteredContacts = useMemo(
    () =>
      contactsForStats.filter((c) => {
        if (filter === 'all') return true;
        if (filter === 'chatsOnly') {
          return c.totalChats > 0 && c.totalConversions === 0;
        }
        if (filter === 'conversions') {
          return c.totalConversions > 0;
        }
        return true;
      }),
    [contactsForStats, filter]
  );

  const handleExportCsv = () => {
    if (!filteredContacts.length) return;

    const header = [
      'Telefono',
      'Total_chats',
      'Total_conversiones',
      'Monto_total',
      'Primer_chat',
      'Linea',
    ];

    const rows = filteredContacts.map((c) => [
      c.phone,
      c.totalChats.toString(),
      c.totalConversions.toString(),
      c.totalAmount.toString(),
      c.firstChatAt ?? '',
      c.lineLabel ?? '',
    ]);

    const csvLines = [header, ...rows]
      .map((cols) =>
        cols
          .map((v) => {
            const s = v.replace(/"/g, '""');
            return `"${s}"`;
          })
          .join(',')
      )
      .join('\n');

    const blob = new Blob([csvLines], {
      type: 'text/csv;charset=utf-8;',
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');

    const suffix =
      filter === 'all'
        ? 'todos'
        : filter === 'chatsOnly'
        ? 'inicio-conversacion'
        : 'conversiones';

    link.href = url;
    link.download = `contactos-${suffix}.csv`;
    link.click();

    URL.revokeObjectURL(url);
  };

  const filterLabel = (key: FilterKey) => {
    switch (key) {
      case 'all':
        return 'Todos';
      case 'chatsOnly':
        return 'Inicio de conversación';
      case 'conversions':
        return 'Conversiones';
    }
  };

  const handleCopyPhone = (phone: string) => {
    if (typeof navigator !== 'undefined' && navigator?.clipboard) {
      navigator.clipboard.writeText(phone).catch(() => {});
    }
  };

  const applyDatePreset = (preset: string) => {
    const today = new Date();
    const toYMD = (d: Date) => d.toISOString().slice(0, 10);

    if (preset === 'today') {
      setFromDate(toYMD(today));
      setToDate(toYMD(today));
      return;
    }
    if (preset === 'yesterday') {
      const y = new Date(today);
      y.setDate(y.getDate() - 1);
      setFromDate(toYMD(y));
      setToDate(toYMD(y));
      return;
    }
    if (preset === '7d') {
      const d = new Date(today);
      d.setDate(d.getDate() - 6);
      setFromDate(toYMD(d));
      setToDate(toYMD(today));
      return;
    }
    if (preset === 'thisMonth') {
      const start = new Date(today.getFullYear(), today.getMonth(), 1);
      setFromDate(toYMD(start));
      setToDate(toYMD(today));
      return;
    }
    if (preset === 'lastMonth') {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const end = new Date(today.getFullYear(), today.getMonth(), 0);
      setFromDate(toYMD(start));
      setToDate(toYMD(end));
      return;
    }
  };

  const chatsOnlyCount = contactsForStats.filter(
    (c) => c.totalChats > 0 && c.totalConversions === 0
  ).length;
  const convCount = contactsForStats.filter(
    (c) => c.totalConversions > 0
  ).length;

  const rateVisitToClick = getRate(stats.chatsTotal, stats.chatsTotal);
  const rateConv = getRate(stats.convTotal, stats.chatsTotal);

  // Abrir panel para cualquier contacto
  const openDetailForContact = async (c: Contact) => {
    setDetailContact(c);
    setDetailConversions([]);
    setDetailError(null);
    setDetailLoading(true);
    setCopiedPhone(false);
    setZoomImageUrl(null);

    try {
      const res = await fetch(
        `/api/contact-conversions?phone=${encodeURIComponent(c.phone)}`
      );
      const json = await res.json();
      if (json.error) {
        setDetailError(json.error);
      }
      setDetailConversions(json.conversions || []);
    } catch (e: any) {
      console.error(e);
      setDetailError(e?.message || 'Error al cargar comprobantes');
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailContact(null);
    setDetailConversions([]);
    setDetailError(null);
    setCopiedPhone(false);
    setZoomImageUrl(null);
  };

  const handleDeleteConversion = async (convId: string) => {
    if (!detailContact) return;
    try {
      const res = await fetch(
        `/api/contact-conversions?id=${encodeURIComponent(convId)}`,
        { method: 'DELETE' }
      );
      const json = await res.json();

      if (!json.success || json.error) {
        console.error('Error al eliminar comprobante', json.error);
        return;
      }

      const deletedAmount = typeof json.amount === 'number' ? json.amount : 0;

      // quitar del panel
      setDetailConversions((prev) => prev.filter((c) => c.id !== convId));

      // actualizar totales del contacto
      setContacts((prev) =>
        prev.map((c) => {
          if (c.phone !== detailContact.phone) return c;
          const newConv = Math.max(0, c.totalConversions - 1);
          const newAmount = Math.max(0, c.totalAmount - deletedAmount);
          return { ...c, totalConversions: newConv, totalAmount: newAmount };
        })
      );

      // actualizar también el objeto que se muestra en el header del panel
      setDetailContact((prev) =>
        prev
          ? {
              ...prev,
              totalConversions: Math.max(0, prev.totalConversions - 1),
              totalAmount: Math.max(0, prev.totalAmount - deletedAmount),
            }
          : prev
      );
    } catch (e) {
      console.error('Error DELETE comprobante', e);
    }
  };

  return (
    <main className="ct-page">
      {/* Header */}
      <header className="ct-dashboard-header">
        <div>
          <h1 className="ct-dashboard-title" style={{ color: '#f9fafb' }}>
            Contactos
          </h1>
          <p className="ct-dashboard-subtitle">
            Listado de personas que chatearon con tus líneas. Filtrá por tipo de
            contacto, línea y rango de fechas.
          </p>

          {loading && (
            <p className="text-sm text-slate-400 mt-2">Cargando contactos...</p>
          )}

          {error && (
            <p className="text-sm text-red-400 mt-2">
              Ocurrió un problema al cargar los contactos.
            </p>
          )}
        </div>

        <div className="flex gap-3 items-center">
          <button
            onClick={handleExportCsv}
            className="px-4 py-2 rounded-xl text-sm font-medium bg-sky-600 hover:bg-sky-500 text-white transition"
            disabled={!filteredContacts.length}
          >
            Exportar a Excel
          </button>

          <Link href="/dashboard" className="ct-dashboard-main-btn">
            ← Volver al dashboard
          </Link>
        </div>
      </header>

      {/* Filtros fecha */}
      <section className="mt-4 flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">
            Desde
          </span>
          <input
            type="date"
            className="ct-filter-input"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-slate-400">
            Hasta
          </span>
          <input
            type="date"
            className="ct-filter-input"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>

        <div className="flex flex-wrap gap-2 mt-4 sm:mt-7">
          <button
            onClick={() => applyDatePreset('today')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/60 border border-slate-700 text-slate-200 hover:border-slate-400 transition"
          >
            Hoy
          </button>
          <button
            onClick={() => applyDatePreset('yesterday')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/60 border border-slate-700 text-slate-200 hover:border-slate-400 transition"
          >
            Ayer
          </button>
          <button
            onClick={() => applyDatePreset('7d')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/60 border border-slate-700 text-slate-200 hover:border-slate-400 transition"
          >
            Últimos 7 días
          </button>
          <button
            onClick={() => applyDatePreset('thisMonth')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/60 border border-slate-700 text-slate-200 hover:border-slate-400 transition"
          >
            Mes actual
          </button>
          <button
            onClick={() => applyDatePreset('lastMonth')}
            className="px-3 py-1.5 rounded-full text-xs font-medium bg-slate-900/60 border border-slate-700 text-slate-200 hover:border-slate-400 transition"
          >
            Mes anterior
          </button>
        </div>
      </section>

      {/* Tabs */}
      <section className="mt-6 mb-4 flex flex-wrap gap-2">
        <button
          onClick={() => setFilter('all')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
            filter === 'all'
              ? 'bg-indigo-600 text-white border-indigo-500'
              : 'bg-slate-900/40 text-slate-300 border-slate-700 hover:border-slate-500'
          }`}
        >
          Todos ({contactsForStats.length})
        </button>

        <button
          onClick={() => setFilter('chatsOnly')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
            filter === 'chatsOnly'
              ? 'bg-violet-600 text-white border-violet-500'
              : 'bg-slate-900/40 text-slate-300 border-slate-700 hover:border-slate-500'
          }`}
        >
          Inicio de conversación ({chatsOnlyCount})
        </button>

        <button
          onClick={() => setFilter('conversions')}
          className={`px-3 py-1.5 rounded-full text-sm font-medium border transition ${
            filter === 'conversions'
              ? 'bg-emerald-600 text-white border-emerald-500'
              : 'bg-slate-900/40 text-slate-300 border-slate-700 hover:border-slate-500'
          }`}
        >
          Conversiones ({convCount})
        </button>
      </section>

      {/* Cards de stats */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div className="ct-summary-card">
          <p className="ct-summary-label text-slate-300">Chats totales</p>
          <p className="ct-summary-value text-white">{stats.chatsTotal}</p>
        </div>

        <div className="ct-summary-card">
          <p className="ct-summary-label text-slate-300">Conversiones</p>
          <p className="ct-summary-value text-white">{stats.convTotal}</p>
          <p className="mt-1 text-sm text-emerald-400 font-semibold">
            Total facturado:{' '}
            <span>
              $
              {stats.revenueTotal.toLocaleString('es-AR', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </span>
          </p>
        </div>
      </section>

      {/* Filtro por línea */}
      <section className="flex items-center justify-end mb-2">
        <div className="flex items-center gap-2 text-xs text-slate-400 mr-4">
          Filtrar por línea:
          <select
            className="ct-filter-select !py-1 !px-3 !text-xs"
            value={selectedLineId}
            onChange={(e) =>
              setSelectedLineId(
                e.target.value === 'all' ? 'all' : e.target.value
              )
            }
          >
            <option value="all">Todas</option>
            {lines.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* Tabla de contactos */}
      <section className="ct-card mt-2">
        <div className="flex items-center justify-between mb-4">
          <h2 className="ct-card-title" style={{ color: '#e5e7eb' }}>
            {filterLabel(filter)} ({filteredContacts.length})
          </h2>
          <p className="text-xs text-slate-400">
            Podés copiar el número para usarlo en WhatsApp o exportar todo a
            Excel.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 pr-4 text-left">Teléfono</th>
                <th className="py-2 pr-4 text-left">Tipo</th>
                <th className="py-2 pr-4 text-left">Monto total</th>
                <th className="py-2 pr-4 text-left">
                  Línea / primer chat
                </th>
              </tr>
            </thead>
            <tbody>
              {!filteredContacts.length && !loading && (
                <tr>
                  <td
                    colSpan={4}
                    className="py-6 text-center text-slate-500"
                  >
                    No hay contactos en este filtro todavía.
                  </td>
                </tr>
              )}

              {filteredContacts.map((c) => {
                const hasConv = c.totalConversions > 0;
                const hasChats = c.totalChats > 0;

                let typeLabel = 'Sin actividad';
                let typeClasses =
                  'bg-slate-800 text-slate-300 border border-slate-600';

                if (hasConv) {
                  typeLabel = 'Conversión';
                  typeClasses =
                    'bg-amber-900/70 text-amber-200 border border-amber-500/60';
                } else if (hasChats) {
                  typeLabel = 'Conversación iniciada';
                  typeClasses =
                    'bg-sky-900/70 text-sky-200 border border-sky-500/60';
                }

                return (
                  <tr
                    key={c.phone + (c.lastEventAt ?? '')}
                    className="border-b border-slate-900/60 hover:bg-slate-900/60 cursor-pointer"
                    onClick={() => openDetailForContact(c)}
                  >
                    {/* Teléfono + avatar + nombre + copiar */}
                    <td className="py-3 pr-4">
                      <div className="flex items-center gap-3">
                        <div className="h-9 w-9 rounded-full bg-slate-800 flex items-center justify-center text-xs font-semibold text-slate-200 overflow-hidden">
                          {c.avatarUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={c.avatarUrl}
                              alt={c.phone}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <span>{c.phone.slice(-2)}</span>
                          )}
                        </div>
                        <div className="flex flex-col gap-0.5">
                          {c.name && (
                            <span className="text-xs font-medium text-slate-100">
                              {c.name}
                            </span>
                          )}
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopyPhone(c.phone);
                              }}
                              className="text-sky-400 hover:text-sky-300 font-medium text-xs"
                            >
                              {c.phone}
                            </button>
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleCopyPhone(c.phone);
                              }}
                              className="text-slate-400 hover:text-slate-200"
                              title="Copiar teléfono"
                            >
                              <svg
                                xmlns="http://www.w3.org/2000/svg"
                                viewBox="0 0 24 24"
                                fill="currentColor"
                                className="h-3.5 w-3.5"
                              >
                                <path d="M8 7a3 3 0 0 1 3-3h7a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-7a3 3 0 0 1-3-3V7Z" />
                                <path d="M4 9a3 3 0 0 1 3-3h1v2H7a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h6v2H7a3 3 0 0 1-3-3V9Z" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </td>

                    {/* Tipo */}
                    <td className="py-3 pr-4">
                      <span
                        className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${typeClasses}`}
                      >
                        {typeLabel}
                      </span>
                    </td>

                    {/* Monto total */}
                    <td className="py-3 pr-4">
                      <span className="text-emerald-400 font-semibold">
                        $
                        {c.totalAmount.toLocaleString('es-AR', {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </span>
                    </td>

                    {/* Línea + fecha */}
                    <td className="py-3 pr-4">
                      <p className="text-xs text-slate-300 mb-1">
                        Línea:{' '}
                        <span className="font-medium">
                          {c.lineLabel ?? '—'}
                        </span>
                      </p>
                      <p className="text-xs text-slate-400">
                        Primer chat:{' '}
                        <span>{formatDateTime(c.firstChatAt)}</span>
                      </p>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Panel lateral de detalle */}
      {detailContact && (
        <div className="fixed inset-y-0 right-0 w-full sm:w-96 md:w-[420px] bg-slate-950 border-l border-slate-800 shadow-xl z-40 flex flex-col">
          {/* header fijo */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
            <h3 className="text-sm font-semibold text-slate-100">
              Detalle de conversiones
            </h3>
            <button
              onClick={closeDetail}
              className="text-slate-400 hover:text-slate-100 text-sm"
            >
              ✕
            </button>
          </div>

          {/* contenido scrollable */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
            {/* Header contacto */}
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-full bg-slate-800 flex items-center justify-center text-xs font-semibold text-slate-200 overflow-hidden">
                {detailContact.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={detailContact.avatarUrl}
                    alt={detailContact.phone}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <span>{detailContact.phone.slice(-2)}</span>
                )}
              </div>

              <div className="flex flex-col">
                {detailContact.name && (
                  <p className="text-xs font-medium text-slate-100">
                    {detailContact.name}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-300">
                    {detailContact.phone}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      handleCopyPhone(detailContact.phone);
                      setCopiedPhone(true);
                      setTimeout(() => setCopiedPhone(false), 1500);
                    }}
                    className="p-1 rounded hover:bg-white/10 transition-colors"
                    title="Copiar número"
                  >
                    {/* icono copiar */}
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 24 24"
                      className="w-4 h-4 text-white/70"
                    >
                      <path
                        fill="currentColor"
                        d="M16 1H6a2 2 0 0 0-2 2v11h2V3h10V1Zm3 4H10a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2Zm0 15h-9V7h9v13Z"
                      />
                    </svg>
                  </button>
                </div>

                {copiedPhone && (
                  <span className="text-[11px] text-emerald-400 mt-0.5">
                    Número copiado
                  </span>
                )}
              </div>
            </div>

            {/* Resumen conversiones */}
            <div className="rounded-xl border border-emerald-500/40 bg-emerald-900/10 px-3 py-2">
              <p className="text-xs text-slate-300">
                Conversiones:{' '}
                <span className="font-semibold text-slate-50">
                  {detailContact.totalConversions}
                </span>
              </p>
              <p className="text-xs text-slate-300">
                Total facturado:{' '}
                <span className="font-semibold text-emerald-400">
                  $
                  {detailContact.totalAmount.toLocaleString('es-AR', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}
                </span>
              </p>
            </div>

            {/* Lista de comprobantes */}
            <div className="space-y-2 pb-2">
              <p className="text-xs font-semibold text-slate-200">
                Comprobantes recibidos
              </p>

              {detailLoading && (
                <p className="text-xs text-slate-400">
                  Cargando comprobantes...
                </p>
              )}

              {detailError && (
                <p className="text-xs text-red-400">{detailError}</p>
              )}

              {!detailLoading &&
                !detailError &&
                detailConversions.length === 0 && (
                  <p className="text-xs text-slate-500">
                    Este contacto no tiene comprobantes registrados.
                  </p>
                )}

              {detailConversions.map((conv, index) => (
                <div
                  key={conv.id}
                  className="rounded-xl bg-slate-900/60 border border-slate-700 p-3 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <p className="text-xs text-slate-400">
                      Comprobante {index + 1}
                    </p>
                    <button
                      type="button"
                      onClick={() => handleDeleteConversion(conv.id)}
                      className="text-[11px] text-red-400 hover:text-red-300"
                    >
                      Eliminar
                    </button>
                  </div>

                  {/* Foto del comprobante si existe */}
                  {conv.screenshot_url && (
                    <div className="relative mt-1 rounded-lg overflow-hidden border border-slate-700 bg-slate-950/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={conv.screenshot_url}
                        alt={`Comprobante ${index + 1}`}
                        className="w-full max-h-60 object-contain bg-black"
                      />

                      {/* botón lupa / zoom */}
                      <button
                        type="button"
                        onClick={() => setZoomImageUrl(conv.screenshot_url!)}
                        className="absolute top-2 right-2 flex items-center justify-center rounded-full bg-black/70 hover:bg-black/90 border border-white/20 p-2 transition-colors"
                        title="Ver comprobante en grande"
                      >
                        <svg
                          xmlns="http://www.w3.org/2000/svg"
                          viewBox="0 0 24 24"
                          className="w-4 h-4 text-white"
                        >
                          <path
                            fill="currentColor"
                            d="M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79L18.99 21 21 18.99 15.5 14Zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14Z"
                          />
                        </svg>
                      </button>
                    </div>
                  )}

                  {/* Monto + fecha */}
                  <div className="flex flex-col gap-1">
                    <p className="text-xs text-emerald-400 font-semibold">
                      $
                      {(conv.amount ?? 0).toLocaleString('es-AR', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </p>
                    <p className="text-[11px] text-slate-500">
                      {formatDateTime(conv.created_at)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Modal de zoom de comprobante */}
      {zoomImageUrl && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center">
          <button
            type="button"
            onClick={() => setZoomImageUrl(null)}
            className="absolute top-5 right-5 p-2 rounded-full bg-black/70 hover:bg-black/90 border border-white/20"
            title="Cerrar"
          >
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              className="w-4 h-4 text-white"
            >
              <path
                fill="currentColor"
                d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.29 19.7 2.88 18.29 9.17 12 2.88 5.71 4.29 4.3 10.59 10.6l6.3-6.3 1.41 1.41Z"
              />
            </svg>
          </button>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={zoomImageUrl}
            alt="Comprobante"
            className="max-w-[90vw] max-h-[90vh] object-contain rounded-xl border border-white/20 shadow-xl"
          />
        </div>
      )}
    </main>
  );
}

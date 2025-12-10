'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';

type WhatsappLine = {
  id: string;
  name: string;
  phoneNumber: string | null;
  status: string; // 'connecting' | 'connected' | 'disconnected' | etc
  createdAt: string;
};

export default function WhatsappLinesPage() {
  const [lines, setLines] = useState<WhatsappLine[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  // ---- Estado para el modal de QR ----
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [connectingLine, setConnectingLine] = useState<WhatsappLine | null>(null);
  const [statusText, setStatusText] = useState('Esperando QR...');
  const [pollIntervalId, setPollIntervalId] = useState<number | null>(null);

  // ---- Estado para links de cajero ----
  const [agentLinkLoadingLineId, setAgentLinkLoadingLineId] = useState<string | null>(null);
  const [agentAllLoading, setAgentAllLoading] = useState(false);
  const [agentPortalModalOpen, setAgentPortalModalOpen] = useState(false);
  const [agentPortalUrl, setAgentPortalUrl] = useState<string | null>(null);
  const [agentPortalTitle, setAgentPortalTitle] = useState<string>('');

  // ==========================
  //   CARGA DE LÍNEAS
  // ==========================
  const loadLines = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/whatsapp-lines');
      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        setError(data.error || 'Error al cargar las líneas');
        setLoading(false);
        return;
      }

      setLines(data.lines || []);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setError('Error de red al cargar las líneas');
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLines();
  }, []);

  // ==========================
  //   CREAR NUEVA LÍNEA
  // ==========================
  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/whatsapp-lines', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });

      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        setError(data.error || 'Error al crear la línea');
        setCreating(false);
        return;
      }

      setName('');
      setCreating(false);
      loadLines();
    } catch (err) {
      console.error(err);
      setError('Error de red al crear la línea');
      setCreating(false);
    }
  };

  // ==========================
  //   CONECTAR POR QR
  // ==========================
  const handleConnectLine = async (line: WhatsappLine) => {
    setConnectingLine(line);
    setQrImage(null);
    setStatusText('Generando QR...');
    setQrModalOpen(true);

    try {
      // 1) Iniciamos conexión en el backend
      const res = await fetch(`/api/whatsapp-lines/${line.id}/connect`, {
        method: 'POST',
      });

      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        console.error('Error connect', data);
        setStatusText(data.error || 'Error al conectar con WhatsApp.');
        return;
      }

      if (data.qr) setQrImage(data.qr as string);

      setStatusText(
        data.status === 'connected'
          ? 'Conectado ✅'
          : 'Escaneá el código desde WhatsApp > Dispositivos vinculados.'
      );

      // 2) Poll del estado cada 3 segundos
      const intervalId = window.setInterval(async () => {
        try {
          const r = await fetch(`/api/whatsapp-lines/${line.id}/status`);
          const s = await r.json().catch(() => ({} as any));

          if (!r.ok) {
            console.error('Status error', s);
            setStatusText(s.error || 'Error al obtener el estado de la línea');
            return;
          }

          // Si vino un QR nuevo lo actualizamos
          if (s.qr) {
            setQrImage(s.qr as string);
          }

          // Actualizamos la línea en memoria (estado + teléfono)
          setLines((prev) =>
            prev.map((l) =>
              l.id === line.id
                ? {
                    ...l,
                    status: s.status ?? l.status,
                    phoneNumber: s.phoneNumber ?? l.phoneNumber,
                  }
                : l
            )
          );

          if (s.status === 'connected') {
            setStatusText('Conectado ✅');
            window.clearInterval(intervalId);
            setPollIntervalId(null);
            setTimeout(() => setQrModalOpen(false), 1200);
          } else if (s.status === 'disconnected') {
            setStatusText('Desconectado');
            window.clearInterval(intervalId);
            setPollIntervalId(null);
          } else {
            setStatusText(
              'Escaneá el código desde WhatsApp en tu celular. Si el QR cambia, se actualiza solo.'
            );
          }
        } catch (err) {
          console.error(err);
          setStatusText('Error al actualizar el estado de la línea.');
        }
      }, 3000);

      setPollIntervalId(intervalId);
    } catch (err) {
      console.error(err);
      setStatusText('Error al conectar con WhatsApp.');
    }
  };

  // ==========================
  //   DESCONECTAR LÍNEA
  // ==========================
  const handleDisconnectLine = async (line: WhatsappLine) => {
    if (!confirm(`¿Seguro que querés desconectar la línea "${line.name}"?`)) return;

    try {
      const res = await fetch(`/api/whatsapp-lines/${line.id}/disconnect`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        console.error('Error disconnect', data);
        alert(data.error || 'Error al desconectar la línea');
        return;
      }

      // Marcamos como desconectada en el frontend
      setLines((prev) =>
        prev.map((l) =>
          l.id === line.id ? { ...l, status: 'disconnected', phoneNumber: null } : l
        )
      );
    } catch (err) {
      console.error(err);
      alert('Error de red al desconectar la línea');
    }
  };

  // ==========================
  //   ELIMINAR LÍNEA
  // ==========================
  const handleDeleteLine = async (line: WhatsappLine) => {
    if (
      !confirm(
        `¿Eliminar la línea "${line.name}"? Se perderá la conexión y no podrás recuperarla.`
      )
    )
      return;

    try {
      const res = await fetch(`/api/whatsapp-lines/${line.id}/delete`, {
        method: 'POST',
      });
      const data = await res.json().catch(() => ({} as any));

      if (!res.ok) {
        console.error('Error delete', data);
        alert(data.error || 'Error al eliminar la línea');
        return;
      }

      // La sacamos del listado
      setLines((prev) => prev.filter((l) => l.id !== line.id));
    } catch (err) {
      console.error(err);
      alert('Error de red al eliminar la línea');
    }
  };

  // ==========================
  //   GENERAR LINK PARA UNA LÍNEA
  // ==========================
  const handleGenerateAgentLinkForLine = async (line: WhatsappLine) => {
    try {
      setAgentPortalTitle(`Link para cajero - ${line.name}`);
      setAgentPortalModalOpen(true);
      setAgentPortalUrl(null);
      setAgentLinkLoadingLineId(line.id);

      const res = await fetch('/api/agent-portal/line', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId: line.id }),
      });

      const data = await res.json().catch(() => ({} as any));

      if (!res.ok || !data.ok) {
        console.error('Error agent-portal line', data);
        setAgentPortalUrl(null);
        return;
      }

      setAgentPortalUrl(data.portalUrl as string);
    } catch (err) {
      console.error(err);
      setAgentPortalUrl(null);
    } finally {
      setAgentLinkLoadingLineId(null);
    }
  };

  // ==========================
  //   GENERAR LINK GENERAL (TODAS LAS LÍNEAS)
  // ==========================
  const handleGenerateAgentLinkAllLines = async () => {
    try {
      setAgentPortalTitle('Link general para todas las líneas');
      setAgentPortalModalOpen(true);
      setAgentPortalUrl(null);
      setAgentAllLoading(true);

      const res = await fetch('/api/agent-portal/all', {
        method: 'POST',
      });

      const data = await res.json().catch(() => ({} as any));

      if (!res.ok || !data.ok) {
        console.error('Error agent-portal all', data);
        setAgentPortalUrl(null);
        return;
      }

      setAgentPortalUrl(data.portalUrl as string);
    } catch (err) {
      console.error(err);
      setAgentPortalUrl(null);
    } finally {
      setAgentAllLoading(false);
    }
  };

  // ==========================
  //   LIMPIEZA DE INTERVALOS
  // ==========================
  useEffect(() => {
    if (!qrModalOpen && pollIntervalId) {
      window.clearInterval(pollIntervalId);
      setPollIntervalId(null);
    }
  }, [qrModalOpen, pollIntervalId]);

  useEffect(() => {
    return () => {
      if (pollIntervalId) {
        window.clearInterval(pollIntervalId);
      }
    };
  }, [pollIntervalId]);

  // ==========================
  //   HELPERS
  // ==========================
  const formatDate = (iso: string) => {
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  };

  const totalConnected = lines.filter((l) => l.status === 'connected').length;

  const humanStatus = (status: string) => {
    if (status === 'connected') return 'Conectada';
    if (status === 'connecting' || status === 'qr') return 'Listo para conectar';
    return 'Desconectada';
  };

  // ==========================
  //   UI
  // ==========================
  return (
    <main className="wa-lines-page">
      <header className="wa-lines-header">
        <div>
          <h1 className="wa-lines-title">Líneas de WhatsApp</h1>
          <p className="wa-lines-subtitle">
            Administrá las líneas conectadas por QR. Más adelante desde acá vas a poder ver
            chats, contactos y conversiones de cada línea.
          </p>
        </div>

        <Link href="/dashboard" className="wa-lines-back">
          ← Volver al dashboard
        </Link>
      </header>

      {/* Top cards */}
      <section className="wa-lines-top">
        {/* Crear nueva línea */}
        <div className="wa-lines-card wa-lines-create-card">
          <h2 className="wa-lines-card-title">Crear nueva línea</h2>
          <p className="wa-lines-card-text">
            Cargá el nombre interno para identificar la línea. Luego vas a poder conectarla por
            código QR y empezar a recibir mensajes.
          </p>

          <form className="wa-lines-create-form" onSubmit={handleCreate}>
            <input
              type="text"
              placeholder="Ej: Línea Uruguay Circo 1"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="wa-lines-input"
            />
            <button
              type="submit"
              disabled={creating || !name.trim()}
              className="wa-lines-btn-primary"
            >
              {creating ? 'Creando...' : 'Crear línea'}
            </button>
          </form>

          {error && <p className="wa-lines-error">{error}</p>}
        </div>

        {/* Resumen */}
        <div className="wa-lines-card wa-lines-summary-card">
          <h2 className="wa-lines-card-title">Resumen rápido</h2>
          <div className="wa-lines-summary-grid">
            <div className="wa-lines-summary-item">
              <span className="wa-lines-summary-label">Líneas totales</span>
              <span className="wa-lines-summary-value">{lines.length}</span>
            </div>
            <div className="wa-lines-summary-item">
              <span className="wa-lines-summary-label">Líneas conectadas</span>
              <span className="wa-lines-summary-value">{totalConnected}</span>
            </div>
            <div className="wa-lines-summary-item">
              <span className="wa-lines-summary-label">Centro de mensajes</span>
              <Link href="/chat" className="wa-lines-small-link">
                Ir al centro de mensajes →
              </Link>
            </div>
            <div className="wa-lines-summary-item">
              <span className="wa-lines-summary-label">Link general para cajeros</span>
              <button
                type="button"
                className="wa-lines-small-link"
                onClick={handleGenerateAgentLinkAllLines}
                disabled={agentAllLoading || lines.length === 0}
              >
                {agentAllLoading ? 'Generando...' : 'Generar link →'}
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* Tabla de líneas */}
      <section className="wa-lines-list-section">
        <div className="wa-lines-list-header">
          <h2 className="wa-lines-card-title">Listado de líneas</h2>
        </div>

        <div className="wa-lines-table-wrapper">
          {loading ? (
            <p className="wa-lines-muted">Cargando líneas...</p>
          ) : lines.length === 0 ? (
            <p className="wa-lines-muted">
              Todavía no creaste ninguna línea. Usá el formulario de arriba para crear la primera.
            </p>
          ) : (
            <table className="wa-lines-table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Teléfono</th>
                  <th>Estado</th>
                  <th>Creada</th>
                  <th className="wa-lines-actions-header">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((line) => (
                  <tr key={line.id}>
                    <td>{line.name}</td>
                    <td>{line.phoneNumber || '-'}</td>
                    <td>
                      <span
                        className={
                          'wa-lines-status-pill ' +
                          (line.status === 'connected'
                            ? 'wa-lines-status-connected'
                            : line.status === 'connecting' || line.status === 'qr'
                            ? 'wa-lines-status-connecting'
                            : 'wa-lines-status-default')
                        }
                      >
                        {humanStatus(line.status)}
                      </span>
                    </td>
                    <td>{formatDate(line.createdAt)}</td>
                    <td className="wa-lines-actions-cell">
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          justifyContent: 'flex-end',
                          alignItems: 'center',
                          flexWrap: 'wrap',
                        }}
                      >
                        {line.status === 'connected' ? (
                          <button
                            type="button"
                            className="wa-lines-btn-ghost"
                            onClick={() => handleDisconnectLine(line)}
                          >
                            Desconectar
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="wa-lines-btn-ghost"
                            onClick={() => handleConnectLine(line)}
                          >
                            Conectar por QR
                          </button>
                        )}

                        {/* Nuevo: link de cajero para esta línea */}
                        <button
                          type="button"
                          className="wa-lines-btn-ghost"
                          onClick={() => handleGenerateAgentLinkForLine(line)}
                          disabled={agentLinkLoadingLineId === line.id}
                          title="Generar link de portal para cajero"
                        >
                          {agentLinkLoadingLineId === line.id
                            ? 'Generando...'
                            : 'Link para cajero'}
                        </button>

                        {/* Botón rojo para eliminar */}
                        <button
                          type="button"
                          onClick={() => handleDeleteLine(line)}
                          style={{
                            borderRadius: 999,
                            border: '1px solid #ef4444',
                            background: 'transparent',
                            color: '#fca5a5',
                            padding: '4px 10px',
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                          title="Eliminar línea"
                        >
                          🗑 Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Modal QR */}
      {qrModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={() => setQrModalOpen(false)}
        >
          <div
            style={{
              background: '#020617',
              borderRadius: 16,
              padding: 24,
              width: 360,
              maxWidth: '90%',
              boxShadow: '0 18px 60px rgba(0,0,0,0.7)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, marginBottom: 8 }}>
              Conectar {connectingLine?.name}
            </h3>
            <p
              style={{
                margin: 0,
                marginBottom: 16,
                fontSize: 13,
                color: '#9ca3af',
              }}
            >
              Abrí WhatsApp en tu celular &gt; Dispositivos vinculados &gt; Vincular
              un dispositivo y escaneá este QR.
            </p>

            <div
              style={{
                width: 260,
                height: 260,
                margin: '0 auto 12px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#020617',
                borderRadius: 12,
                border: '1px solid #1f2933',
              }}
            >
              {qrImage ? (
                <img
                  src={qrImage}
                  alt="QR de WhatsApp"
                  style={{ width: '100%', height: '100%' }}
                />
              ) : (
                <span style={{ color: '#9ca3af', fontSize: 13 }}>
                  Generando QR...
                </span>
              )}
            </div>

            <p
              style={{
                fontSize: 12,
                color: '#9ca3af',
                marginTop: 4,
                marginBottom: 16,
              }}
            >
              {statusText}
            </p>

            <button
              onClick={() => setQrModalOpen(false)}
              style={{
                width: '100%',
                padding: '8px 0',
                borderRadius: 999,
                border: 'none',
                fontSize: 13,
                cursor: 'pointer',
                background: '#111827',
                color: '#e5e7eb',
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}

      {/* Modal link de cajero */}
      {agentPortalModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.6)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
          onClick={() => setAgentPortalModalOpen(false)}
        >
          <div
            style={{
              background: '#020617',
              borderRadius: 16,
              padding: 24,
              width: 420,
              maxWidth: '90%',
              boxShadow: '0 18px 60px rgba(0,0,0,0.7)',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <h3 style={{ margin: 0, marginBottom: 8 }}>
              {agentPortalTitle || 'Link para cajero'}
            </h3>
            <p
              style={{
                margin: 0,
                marginBottom: 16,
                fontSize: 13,
                color: '#9ca3af',
              }}
            >
              Pasale este link a tu cajero/empleado. Solo podrá ver y responder los chats
              desde FlowTracking, sin entrar a tu cuenta ni ver analytics, contactos o
              facturación.
            </p>

            {agentPortalUrl ? (
              <div
                style={{
                  background: '#020617',
                  borderRadius: 10,
                  border: '1px solid #1f2937',
                  padding: 12,
                  fontSize: 13,
                  wordBreak: 'break-all',
                  color: '#e5e7eb',
                  marginBottom: 12,
                }}
              >
                {agentPortalUrl}
              </div>
            ) : (
              <p style={{ fontSize: 12, color: '#9ca3af' }}>Generando link...</p>
            )}

            <button
              onClick={() => {
                if (agentPortalUrl) {
                  navigator.clipboard.writeText(agentPortalUrl).catch(() => undefined);
                }
              }}
              style={{
                width: '100%',
                padding: '8px 0',
                borderRadius: 999,
                border: 'none',
                fontSize: 13,
                cursor: 'pointer',
                background: '#16a34a',
                color: '#ecfdf5',
                marginBottom: 8,
              }}
              disabled={!agentPortalUrl}
            >
              Copiar link
            </button>

            <button
              onClick={() => setAgentPortalModalOpen(false)}
              style={{
                width: '100%',
                padding: '8px 0',
                borderRadius: 999,
                border: 'none',
                fontSize: 13,
                cursor: 'pointer',
                background: '#111827',
                color: '#e5e7eb',
              }}
            >
              Cerrar
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
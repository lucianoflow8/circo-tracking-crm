'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

type Contact = {
  id: string;
  phone: string;
  name: string | null;
  firstContactAt: string | null;
  lastMessageAt: string | null;
  totalMessages: number;
  createdAt: string;
};

export default function WhatsappLineDetailPage() {
  const params = useParams();
  const lineId = params?.lineId as string;

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadContacts = async () => {
    if (!lineId) return;
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/contacts?lineId=${lineId}`);
      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al cargar contactos');
        setLoading(false);
        return;
      }

      setContacts(data.contacts || []);
      setLoading(false);
    } catch (err) {
      console.error(err);
      setError('Error de red');
      setLoading(false);
    }
  };

  useEffect(() => {
    loadContacts();
  }, [lineId]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!phone.trim()) return;

    setCreating(true);
    setError(null);

    try {
      const res = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lineId, phone, name }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al crear contacto');
        setCreating(false);
        return;
      }

      setPhone('');
      setName('');
      setCreating(false);
      loadContacts();
    } catch (err) {
      console.error(err);
      setError('Error de red');
      setCreating(false);
    }
  };

  return (
    <main
      style={{
        display: 'flex',
        minHeight: '100vh',
        background: '#05070b',
        color: '#f5f5f5',
        fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      }}
    >
      {/* SIDEBAR IZQUIERDO */}
      <aside
        style={{
          width: 230,
          borderRight: '1px solid #141923',
          padding: 16,
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
          background: '#05070b',
        }}
      >
        <div>
          <div style={{ fontSize: 12, color: '#a0a4b4', marginBottom: 4 }}>
            PROYECTO
          </div>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Circo Tracking</div>
        </div>

        <nav style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.6,
              color: '#6b7183',
              marginBottom: 4,
            }}
          >
            Sesiones
          </div>

          {/* Contactos (ACTIVA) */}
          <button
            type="button"
            style={{
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: 6,
              border: 'none',
              cursor: 'default',
              fontSize: 14,
              background: '#0b101a',
              color: '#ffffff',
            }}
          >
            Contactos
          </button>

          {/* Placeholders para lo que viene después */}
          <button
            type="button"
            disabled
            style={{
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: 6,
              border: 'none',
              cursor: 'not-allowed',
              fontSize: 14,
              background: 'transparent',
              color: '#5f6473',
            }}
          >
            Conversiones (próx.)
          </button>
          <button
            type="button"
            disabled
            style={{
              textAlign: 'left',
              padding: '8px 10px',
              borderRadius: 6,
              border: 'none',
              cursor: 'not-allowed',
              fontSize: 14,
              background: 'transparent',
              color: '#5f6473',
            }}
          >
            Chat / Historial (próx.)
          </button>
        </nav>

        <div
          style={{
            marginTop: 'auto',
            fontSize: 12,
            color: '#6b7183',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <Link href="/whatsapp-lines" style={{ color: '#9ca3ff', textDecoration: 'none' }}>
            ← Volver a líneas
          </Link>
          <Link href="/dashboard" style={{ color: '#9ca3ff', textDecoration: 'none' }}>
            Dashboard
          </Link>
        </div>
      </aside>

      {/* CONTENIDO DERECHA */}
      <section
        style={{
          flex: 1,
          padding: '24px 32px',
        }}
      >
        <header style={{ marginBottom: 24 }}>
          <h1 style={{ fontSize: 20, marginBottom: 6 }}>Contactos</h1>
          <p style={{ fontSize: 13, color: '#9ca3b8' }}>
            Lista de contactos de esta línea de WhatsApp. Más adelante esto se va a llenar solo
            con la gente que escriba por el enlace de la página.
          </p>
        </header>

        {/* Card: agregar contacto */}
        <div
          style={{
            maxWidth: 560,
            padding: 16,
            borderRadius: 10,
            border: '1px solid #161b26',
            background: '#080c13',
            marginBottom: 24,
          }}
        >
          <h2 style={{ marginBottom: 8, fontSize: 16 }}>Agregar contacto manual</h2>
          <p style={{ fontSize: 12, color: '#8b91a3', marginBottom: 12 }}>
            Para probar el CRM podés cargar contactos a mano. Después esto se va a hacer automático
            desde WhatsApp.
          </p>
          <form
            onSubmit={handleCreate}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <input
              type="text"
              placeholder="Teléfono (ej: +598...)"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              style={{
                padding: 8,
                borderRadius: 6,
                border: '1px solid #1c2230',
                background: '#05070b',
                color: '#f5f5f5',
                fontSize: 14,
              }}
            />
            <input
              type="text"
              placeholder="Nombre (opcional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={{
                padding: 8,
                borderRadius: 6,
                border: '1px solid #1c2230',
                background: '#05070b',
                color: '#f5f5f5',
                fontSize: 14,
              }}
            />
            <button
              type="submit"
              disabled={creating}
              style={{
                marginTop: 4,
                padding: '8px 16px',
                alignSelf: 'flex-start',
                borderRadius: 6,
                border: 'none',
                fontSize: 14,
                background: '#16a34a',
                color: '#ffffff',
                cursor: creating ? 'default' : 'pointer',
                opacity: creating ? 0.8 : 1,
              }}
            >
              {creating ? 'Guardando...' : 'Agregar contacto'}
            </button>
          </form>
          {error && (
            <p style={{ color: '#f97373', marginTop: 8, fontSize: 13 }}>
              {error}
            </p>
          )}
        </div>

        {/* Tabla de contactos */}
        <div
          style={{
            borderRadius: 10,
            border: '1px solid #161b26',
            background: '#080c13',
            padding: 16,
          }}
        >
          <h2 style={{ marginBottom: 12, fontSize: 16 }}>Listado de contactos</h2>

          {loading ? (
            <p style={{ fontSize: 13, color: '#9ca3b8' }}>Cargando contactos...</p>
          ) : contacts.length === 0 ? (
            <p style={{ fontSize: 13, color: '#9ca3b8' }}>
              No hay contactos aún para esta línea.
            </p>
          ) : (
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: 13,
              }}
            >
              <thead>
                <tr>
                  <th
                    style={{
                      borderBottom: '1px solid #161b26',
                      textAlign: 'left',
                      padding: 8,
                      fontWeight: 500,
                      color: '#aeb4c8',
                    }}
                  >
                    Teléfono
                  </th>
                  <th
                    style={{
                      borderBottom: '1px solid #161b26',
                      textAlign: 'left',
                      padding: 8,
                      fontWeight: 500,
                      color: '#aeb4c8',
                    }}
                  >
                    Nombre
                  </th>
                  <th
                    style={{
                      borderBottom: '1px solid #161b26',
                      textAlign: 'left',
                      padding: 8,
                      fontWeight: 500,
                      color: '#aeb4c8',
                    }}
                  >
                    Primer contacto
                  </th>
                  <th
                    style={{
                      borderBottom: '1px solid #161b26',
                      textAlign: 'left',
                      padding: 8,
                      fontWeight: 500,
                      color: '#aeb4c8',
                    }}
                  >
                    Último mensaje
                  </th>
                  <th
                    style={{
                      borderBottom: '1px solid #161b26',
                      textAlign: 'left',
                      padding: 8,
                      fontWeight: 500,
                      color: '#aeb4c8',
                    }}
                  >
                    Mensajes
                  </th>
                </tr>
              </thead>
              <tbody>
                {contacts.map((c) => (
                  <tr key={c.id}>
                    <td
                      style={{
                        borderBottom: '1px solid #111623',
                        padding: 8,
                        color: '#e5e7f0',
                      }}
                    >
                      {c.phone}
                    </td>
                    <td
                      style={{
                        borderBottom: '1px solid #111623',
                        padding: 8,
                        color: '#e5e7f0',
                      }}
                    >
                      {c.name || '-'}
                    </td>
                    <td
                      style={{
                        borderBottom: '1px solid #111623',
                        padding: 8,
                        color: '#c1c6d8',
                      }}
                    >
                      {c.firstContactAt
                        ? new Date(c.firstContactAt).toLocaleString()
                        : '-'}
                    </td>
                    <td
                      style={{
                        borderBottom: '1px solid #111623',
                        padding: 8,
                        color: '#c1c6d8',
                      }}
                    >
                      {c.lastMessageAt
                        ? new Date(c.lastMessageAt).toLocaleString()
                        : '-'}
                    </td>
                    <td
                      style={{
                        borderBottom: '1px solid #111623',
                        padding: 8,
                        color: '#e5e7f0',
                      }}
                    >
                      {c.totalMessages}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

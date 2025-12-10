"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type DashboardSummary = {
  totalContacts: number;
  totalConversions: number;
  totalRevenue: number;
  error?: string;
};

type WhatsappLine = {
  id: string;
  name: string | null;
  phoneNumber: string | null;
  status: string | null;
  createdAt: string;
};

export default function DashboardPage() {
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [linesConnected, setLinesConnected] = useState(0);

  useEffect(() => {
    const fetchData = async () => {
      try {
        // Resumen (contactos / conversiones / revenue)
        const summaryRes = await fetch("/api/dashboard-summary");
        if (summaryRes.ok) {
          const json: DashboardSummary = await summaryRes.json();
          setSummary(json);
        } else {
          console.error(
            "Error /api/dashboard-summary",
            summaryRes.status
          );
        }

        // Líneas de WhatsApp (aisladas por usuario en el backend)
        const linesRes = await fetch("/api/whatsapp-lines");
        if (linesRes.ok) {
          const json = await linesRes.json();
          const lines = (json.lines || []) as WhatsappLine[];

          // si querés sólo las conectadas:
          const connected = lines.filter(
            (l) => l.status === "connected"
          ).length;

          setLinesConnected(connected);
        } else {
          console.error(
            "Error /api/whatsapp-lines",
            linesRes.status
          );
        }
      } catch (e) {
        console.error("Error cargando datos de dashboard", e);
      }
    };

    fetchData();
  }, []);

  const totalContacts = summary?.totalContacts ?? 0;
  const totalConversions = summary?.totalConversions ?? 0;
  const totalRevenue = summary?.totalRevenue ?? 0;

  return (
    <main className="ct-dashboard-page">
      {/* Header */}
      <header className="ct-dashboard-header">
        <div>
          <h1 className="ct-dashboard-title">Circo Tracking · Dashboard</h1>
          <p className="ct-dashboard-subtitle">
            Visualizá y administrá todo lo importante de tu circo en un solo
            lugar: líneas de WhatsApp, contactos, conversiones y páginas.
          </p>
        </div>

        <Link href="/whatsapp-lines" className="ct-dashboard-main-btn">
          + Agregar línea de WhatsApp
        </Link>
      </header>

      {/* Tarjetas de resumen */}
      <section className="ct-dashboard-summary-grid">
        {/* Líneas conectadas */}
        <div className="ct-summary-card">
          <p className="ct-summary-label">Líneas conectadas</p>
          <p className="ct-summary-value">{linesConnected}</p>
          <p className="ct-summary-helper">WhatsApp Web por QR</p>
        </div>

        {/* Contactos totales */}
        <div className="ct-summary-card">
          <p className="ct-summary-label">Contactos totales</p>
          <p className="ct-summary-value">{totalContacts}</p>

          <p className="ct-summary-helper">
            <Link
              href="/contactos"
              className="text-sky-400 hover:text-sky-300 hover:underline underline-offset-2"
            >
              Ver todos los contactos
            </Link>
          </p>
        </div>

        {/* Conversiones */}
        <div className="ct-summary-card">
          <p className="ct-summary-label">Conversiones</p>
          <p className="ct-summary-value">{totalConversions}</p>
          <p className="ct-summary-helper">
            Personas que enviaron comprobante.
          </p>
          <p className="ct-summary-helper" style={{ marginTop: "0.25rem" }}>
            Ingresos totales:{" "}
            <span className="text-emerald-400 font-semibold">
              ${totalRevenue.toLocaleString("es-AR")}
            </span>
          </p>
        </div>
      </section>

      {/* Bloques principales */}
      <section className="ct-dashboard-card-grid">
        {/* Líneas */}
        <div className="ct-card">
          <h2 className="ct-card-title">Líneas de WhatsApp</h2>
          <p className="ct-card-text">
            Administrá todas las líneas conectadas por QR. Desde acá vas a poder
            ver los contactos, chats y conversiones de cada línea.
          </p>
          <button className="ct-card-btn">
            <Link href="/whatsapp-lines">Ir a líneas</Link>
          </button>
        </div>

        {/* Páginas */}
        <div className="ct-card">
          <h2 className="ct-card-title">Páginas (landing)</h2>
          <p className="ct-card-text">
            Creá páginas personalizadas para tus campañas: fondo, textos, botón
            de WhatsApp, pixel y token de acceso de Meta. Ideal para enviar
            tráfico desde los anuncios.
          </p>
          <button className="ct-card-btn">
            <Link href="/pages">Ir a páginas</Link>
          </button>
        </div>

        {/* Centro de mensajes */}
        <div className="ct-card">
          <h2 className="ct-card-title">Centro de mensajes</h2>
          <p className="ct-card-text">
            Respondé los mensajes de todas tus líneas en un solo lugar. Lista de
            contactos a la izquierda y el chat completo a la derecha.
          </p>
          <button className="ct-card-btn">
            <Link href="/chat">Ir a bandeja de mensajes</Link>
          </button>
        </div>

        {/* Analytics */}
        <div className="ct-card">
          <h2 className="ct-card-title">Analytics</h2>
          <p className="ct-card-text">
            Visualizá el rendimiento de tus páginas y líneas: vistas, clics al
            botón, chats iniciados y conversiones. Gráficos claros para ver qué
            está funcionando mejor.
          </p>
          <button className="ct-card-btn">
            <Link href="/analytics">Ver analytics</Link>
          </button>
        </div>
      </section>
    </main>
  );
}
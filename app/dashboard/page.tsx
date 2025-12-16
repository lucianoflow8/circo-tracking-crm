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
        const summaryRes = await fetch("/api/dashboard-summary");
        if (summaryRes.ok) {
          const json: DashboardSummary = await summaryRes.json();
          setSummary(json);
        } else {
          console.error("Error /api/dashboard-summary", summaryRes.status);
        }

        const linesRes = await fetch("/api/whatsapp-lines");
        if (linesRes.ok) {
          const json = await linesRes.json();
          const lines = (json.lines || []) as WhatsappLine[];
          const connected = lines.filter((l) => l.status === "connected").length;
          setLinesConnected(connected);
        } else {
          console.error("Error /api/whatsapp-lines", linesRes.status);
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
    <main className="ct-dashboard-page ct-dash-neo">
      <header className="ct-dashboard-header">
        <div>
          <h1 className="ct-dashboard-title">FLOW CRM · MENU</h1>
          <p className="ct-dashboard-subtitle">
            Visualizá y administrá todo lo importante: líneas, contactos, conversiones y páginas.
          </p>
        </div>

        <Link href="/whatsapp-lines" className="ct-dashboard-main-btn">
          + Agregar línea de WhatsApp
        </Link>
      </header>

      <section className="ct-dashboard-summary-grid">
        <div className="ct-summary-card">
          <p className="ct-summary-label">Líneas conectadas</p>
          <p className="ct-summary-value">{linesConnected}</p>
          <p className="ct-summary-helper">WhatsApp Web por QR</p>
        </div>

        <div className="ct-summary-card">
          <p className="ct-summary-label">Contactos totales</p>
          <p className="ct-summary-value">{totalContacts}</p>
          <p className="ct-summary-helper">
            <Link href="/contactos" className="ct-link">
              Ver todos los contactos →
            </Link>
          </p>
        </div>

        <div className="ct-summary-card">
          <p className="ct-summary-label">Conversiones</p>
          <p className="ct-summary-value">{totalConversions}</p>
          <p className="ct-summary-helper">Personas que enviaron comprobante.</p>
          <p className="ct-summary-helper" style={{ marginTop: 6 }}>
            Ingresos totales:{" "}
            <span className="ct-money">${totalRevenue.toLocaleString("es-AR")}</span>
          </p>
        </div>
      </section>

      {/* 3 arriba + 1 abajo (wide) */}
      <section className="ct-dashboard-card-grid">
        <div className="ct-card">
          <h2 className="ct-card-title">Líneas de WhatsApp</h2>
          <p className="ct-card-text">
            Administrá tus líneas conectadas por QR. Entrá para ver contactos, chats y conversiones.
          </p>
          <Link href="/whatsapp-lines" className="ct-card-btn">
            Ir a líneas
          </Link>
        </div>

        <div className="ct-card">
          <h2 className="ct-card-title">Páginas (landing)</h2>
          <p className="ct-card-text">
            Creá landings con botón de WhatsApp, pixel y token de Meta para campañas y tracking real.
          </p>
          <Link href="/pages" className="ct-card-btn">
            Ir a páginas
          </Link>
        </div>

        <div className="ct-card">
          <h2 className="ct-card-title">Centro de mensajes</h2>
          <p className="ct-card-text">Respondé mensajes de todas tus líneas en un solo lugar.</p>
          <Link href="/chat" className="ct-card-btn">
            Ir a bandeja
          </Link>
        </div>

        <div className="ct-card ct-card-wide">
          <h2 className="ct-card-title">Analytics</h2>
          <p className="ct-card-text">
            Vistas, clics, chats y conversiones con métricas claras para decidir rápido.
          </p>
          <Link href="/analytics" className="ct-card-btn">
            Ver analytics
          </Link>
        </div>
      </section>
    </main>
  );
}
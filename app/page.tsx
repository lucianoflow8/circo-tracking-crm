// app/page.tsx
import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="hero">
      <div className="hero-inner">
        {/* Badge versión */}
        <div className="hero-version-badge">
          <span className="hero-version-dot" />
          <span>VERSIÓN 1.0</span>
        </div>

        {/* Título */}
        <h1 className="hero-title">
          Bienvenido al CRM
          <br />
          <span className="hero-title-gradient">específico para circos</span>
        </h1>

        {/* Subtítulo */}
        <p className="hero-subtitle">
          Resolvemos y dedicamos nuestros recursos en ofrecerte soluciones ideales
          para que logres el siguiente nivel. Controla ventas, tracking, APIs,
          landing y ads en un solo lugar.
        </p>

        {/* Botones principales */}
        <div className="hero-buttons">
          <Link href="/register" className="hero-btn hero-btn-primary">
            Registrarme →
          </Link>

          <Link href="/login" className="hero-btn hero-btn-secondary">
            ⟶ Iniciar sesión
          </Link>
        </div>

        {/* Link Telegram */}
        <div className="hero-telegram">
          <a
            href="https://t.me/tu-grupo-de-telegram"
            target="_blank"
            rel="noreferrer"
          >
            ✈️ Unirme al grupo de Telegram
          </a>
        </div>

        {/* Footer */}
        <div className="hero-footer">
          © {new Date().getFullYear()} CIRCO TRACKING CRM. Todos los derechos
          reservados.
        </div>
      </div>
    </main>
  );
}

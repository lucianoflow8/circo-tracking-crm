// app/page.tsx
import Link from "next/link";

const OPS_FEED = `[OK] session: initialized
[OK] whatsapp: multi-line ready
[OK] api: routes online
[OK] tracking: events enabled
[OK] landing: links active
[OK] ads: pipeline armed
[OK] db: connected
[OK] queue: running
[OK] audit: enabled`;

export default function HomePage() {
  return (
    <main className="matrix-hero">
      <div className="matrix-wrap">
        {/* header minimal */}
        <header className="matrix-header">
          <div className="matrix-brand">
            <span className="matrix-dot" />
            <span className="matrix-brand-title">FLOW TRACKING</span>
            <span className="matrix-brand-sub">CRM</span>
          </div>

          <div className="matrix-status">
            <span className="matrix-pill">SECURE</span>
            <span className="matrix-pill matrix-pill-on">ONLINE</span>
            <span className="matrix-pill">BUILD 1.0</span>
          </div>
        </header>

        {/* content layout: left + right */}
        <section className="matrix-layout">
          {/* LEFT */}
          <div className="matrix-main">
            <div className="matrix-terminal">
              <div className="matrix-terminal-top">
                <span className="matrix-led" />
                <span className="matrix-led" />
                <span className="matrix-led" />
                <span className="matrix-terminal-title">root@circo-crm:~</span>
              </div>

              <div className="matrix-terminal-body">
                <div className="matrix-line">
                  <span className="matrix-prompt">$</span> boot --mode multi-line
                  <span className="matrix-caret" />
                </div>
                <div className="matrix-line matrix-dim">
                  ✓ chat • ✓ tracking • ✓ landing • ✓ ads • ✓ api
                </div>
                <div className="matrix-line matrix-dim">
                  status: <span className="matrix-ok">READY</span> | env:{" "}
                  <span className="matrix-ok">PROD</span>
                </div>
              </div>
            </div>

            <h1 className="matrix-h1">
              Control total.
              <br />
              <span className="matrix-h1-accent">Modo Operación.</span>
            </h1>

            <p className="matrix-p">
              CRM BLACK para circos/empresas: ventas, tracking, APIs, landing y ads en
              un solo panel. Rápido, claro y pensado para laburar sin distracciones.
            </p>

            <ul className="matrix-list">
              <li>• Multi-línea (cada usuario con su WhatsApp)</li>
              <li>• Conversaciones + comprobantes + control</li>
              <li>• Métricas reales (visitas → chats → conversiones)</li>
            </ul>

            <div className="matrix-cta">
              <Link href="/login" className="matrix-btn matrix-btn-primary">
                Iniciar sesión
              </Link>

              <Link href="/register" className="matrix-btn matrix-btn-ghost">
                Crear cuenta
              </Link>

              <a
                className="matrix-btn matrix-btn-link"
                href="https://t.me/tu-grupo-de-telegram"
                target="_blank"
                rel="noreferrer"
              >
                + Unirme al canal de Telegram
              </a>
            </div>
          </div>

          {/* RIGHT: ops console feed */}
          <aside className="matrix-side" aria-hidden="true">
            <div className="matrix-side-top">
              <span className="matrix-side-tag">OPS FEED</span>
              <span className="matrix-side-hint">stream://status</span>
            </div>

            <div className="matrix-side-box">
              <div className="matrix-side-overlay" />
              <pre className="matrix-side-pre">{OPS_FEED}</pre>
            </div>

            <div className="matrix-side-foot">
              <span className="matrix-mini-pill">audit:on</span>
              <span className="matrix-mini-pill">queue:run</span>
              <span className="matrix-mini-pill">shield:ok</span>
            </div>
          </aside>
        </section>

        <footer className="matrix-footer">
          © {new Date().getFullYear()} FLOW TRACKING CRM
        </footer>
      </div>
    </main>
  );
}

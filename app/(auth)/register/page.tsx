'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function RegisterPage() {
  const router = useRouter();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !password.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al crear la cuenta');
        setLoading(false);
        return;
      }

      router.push('/login');
    } catch (err) {
      console.error(err);
      setError('Error de red');
      setLoading(false);
    }
  };

  return (
    <main className="matrix-hero">
      <div className="matrix-wrap">
        <Link href="/" className="auth-back">
        </Link>

        <section className="auth-center">
          <div className="auth-simple-card">
            {/* Mascara (misma del login) */}
            <div className="auth-mask-wrap" aria-hidden="true">
              <img className="auth-mask" src="/anon.png" alt="" />
            </div>

            <h1 className="auth-simple-title">Crear cuenta</h1>
            <p className="auth-simple-subtitle">
              Registrate para empezar a gestionar tus líneas y conversiones.
            </p>

            <form onSubmit={handleSubmit} className="auth-form auth-simple-form">
              <label className="auth-label auth-simple-label">
                Nombre
                <input
                  type="text"
                  className="auth-input auth-simple-input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Mati Ads"
                  autoComplete="name"
                />
              </label>

              <label className="auth-label auth-simple-label">
                Email
                <input
                  type="email"
                  className="auth-input auth-simple-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="flowtracking@crm.com"
                  autoComplete="email"
                />
              </label>

              <label className="auth-label auth-simple-label">
                Contraseña
                <input
                  type="password"
                  className="auth-input auth-simple-input"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Mínimo 6 caracteres"
                  autoComplete="new-password"
                />
              </label>

              {error && <p className="auth-error auth-simple-error">{error}</p>}

              {/* botón nuclear pero en cyan (pro) */}
              <button
                type="submit"
                className="auth-button auth-nuclear-btn auth-nuclear-cyan"
                disabled={loading}
              >
                {loading ? 'Creando cuenta…' : 'Crear cuenta'}
              </button>
            </form>

            <p className="auth-footer-text auth-simple-footer">
              ¿Ya tenés cuenta?{' '}
              <Link href="/login" className="auth-footer-link auth-simple-link">
                Iniciar sesión
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
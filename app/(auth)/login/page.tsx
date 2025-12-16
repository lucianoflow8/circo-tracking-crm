'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password.trim()) return;

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Error al iniciar sesión');
        setLoading(false);
        return;
      }

      router.push('/dashboard');
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
            <div className="auth-mask-wrap" aria-hidden="true">
              <img className="auth-mask" src="/anon.png" alt="" />
            </div>

            <h1 className="auth-simple-title">Bienvenido de nuevo</h1>
            <p className="auth-simple-subtitle">Inicia sesión tu panel de control</p>

            <form onSubmit={handleSubmit} className="auth-form auth-simple-form">
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
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </label>

              {error && <p className="auth-error auth-simple-error">{error}</p>}

              <button type="submit" className="auth-button auth-nuclear-btn" disabled={loading}>
                {loading ? 'Ingresando…' : 'Iniciar sesión'}
              </button>
            </form>

            <p className="auth-footer-text auth-simple-footer">
              ¿No tenés una cuenta?{' '}
              <Link href="/register" className="auth-footer-link auth-simple-link">
                Registrate aquí
              </Link>
            </p>
          </div>
        </section>
      </div>
    </main>
  );
}
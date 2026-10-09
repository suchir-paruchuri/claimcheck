import { useState, type FormEvent } from 'react';
import { api, isDemo } from '../api';
import { useSession } from '../App';

export default function AuthPage() {
  const { setUser } = useSession();
  const [mode, setMode] = useState<'signin' | 'signup'>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState(isDemo ? 'demo@claimcheck.app' : '');
  const [password, setPassword] = useState(isDemo ? 'demo-password' : '');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      setUser(mode === 'signin' ? await api.login(email, password) : await api.signup(name, email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <section className="auth-intro">
        <h1>Find the mistakes on your medical bill before you pay it.</h1>
        <p>
          Upload an itemized bill. ClaimCheck checks every line against Medicare's billing rules and
          prices, shows you what looks wrong and why, and drafts a dispute letter you can send.
        </p>
      </section>

      <form className="auth-form" onSubmit={submit} noValidate>
        <h2>{mode === 'signin' ? 'Sign in' : 'Create your account'}</h2>
        {mode === 'signup' && (
          <label>
            Your name <span className="hint">used to sign your dispute letters</span>
            <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Password {mode === 'signup' && <span className="hint">at least 10 characters</span>}
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            required
          />
        </label>
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="primary" disabled={busy}>
          {busy ? 'One moment…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </button>
        <p className="switch">
          {mode === 'signin' ? 'New here?' : 'Already have an account?'}{' '}
          <button type="button" className="link-button" onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(undefined); }}>
            {mode === 'signin' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </form>
    </div>
  );
}

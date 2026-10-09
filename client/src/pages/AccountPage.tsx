import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, isDemo } from '../api';
import { useSession } from '../App';

type Status = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; message: string } | { kind: 'error'; message: string };

/** Runs a form action and tracks its busy, success, and error states. */
function useAction() {
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  async function run(action: () => Promise<string>) {
    setStatus({ kind: 'busy' });
    try {
      setStatus({ kind: 'done', message: await action() });
    } catch (err) {
      setStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Something went wrong. Try again.' });
    }
  }
  return { status, run, busy: status.kind === 'busy' };
}

function StatusLine({ status }: { status: Status }) {
  if (status.kind === 'done') return <p className="form-success" role="status">{status.message}</p>;
  if (status.kind === 'error') return <p className="form-error" role="alert">{status.message}</p>;
  return null;
}

function Section({ title, children, danger }: { title: string; children: ReactNode; danger?: boolean }) {
  return (
    <section className={`account-section ${danger ? 'account-danger' : ''}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function AccountPage() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  if (!user) return null;
  const memberSince = user.createdAt
    ? new Date(user.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : undefined;

  return (
    <div className="account">
      <nav className="crumbs"><Link to="/">Your bills</Link></nav>
      <h1>Your account</h1>
      <dl className="account-summary">
        <dt>Name</dt><dd>{user.name}</dd>
        <dt>Email</dt><dd>{user.email}</dd>
        {memberSince && (<><dt>Member since</dt><dd>{memberSince}</dd></>)}
      </dl>
      {isDemo && <p className="hint">Demo mode: changes last until you reload the page. The demo password is "demo-password".</p>}

      <NameForm initial={user.name} onSaved={setUser} />
      <EmailForm current={user.email} onSaved={setUser} />
      <PasswordForm onSaved={setUser} />
      <DeleteForm onDeleted={() => { setUser(null); navigate('/signin', { replace: true }); }} />
    </div>
  );
}

function NameForm({ initial, onSaved }: { initial: string; onSaved: (u: Awaited<ReturnType<typeof api.updateName>>) => void }) {
  const [name, setName] = useState(initial);
  const { status, run, busy } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      onSaved(await api.updateName(name));
      return 'Name saved.';
    });
  };
  return (
    <Section title="Name">
      <form onSubmit={submit} className="account-form">
        <label>
          Your name <span className="hint">shown in your greeting and used to sign your dispute letters</span>
          <input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={100} required />
        </label>
        <StatusLine status={status} />
        <button className="primary" disabled={busy || !name.trim() || name.trim() === initial}>{busy ? 'Saving…' : 'Save name'}</button>
      </form>
    </Section>
  );
}

function EmailForm({ current, onSaved }: { current: string; onSaved: (u: Awaited<ReturnType<typeof api.changeEmail>>) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { status, run, busy } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const user = await api.changeEmail(email, password);
      onSaved(user);
      setEmail('');
      setPassword('');
      return `Email changed. Sign in with ${user.email} from now on.`;
    });
  };
  return (
    <Section title="Email">
      <form onSubmit={submit} className="account-form">
        <p className="hint">You sign in with {current}.</p>
        <label>
          New email
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
        </label>
        <label>
          Current password <span className="hint">to confirm it's you</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <StatusLine status={status} />
        <button className="primary" disabled={busy || !email || !password}>{busy ? 'Saving…' : 'Change email'}</button>
      </form>
    </Section>
  );
}

function PasswordForm({ onSaved }: { onSaved: (u: Awaited<ReturnType<typeof api.changePassword>>) => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { status, run, busy } = useAction();
  const mismatch = confirm.length > 0 && next !== confirm;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      if (next.length < 10) throw new Error('Your new password must be at least 10 characters.');
      if (next !== confirm) throw new Error('The new passwords don’t match.');
      onSaved(await api.changePassword(current, next));
      setCurrent('');
      setNext('');
      setConfirm('');
      return 'Password changed. You’ve been signed out on your other devices.';
    });
  };
  return (
    <Section title="Password">
      <form onSubmit={submit} className="account-form">
        <label>
          Current password
          <input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </label>
        <label>
          New password <span className="hint">at least 10 characters</span>
          <input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={10} required />
        </label>
        <label>
          Confirm new password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
            required
          />
          {mismatch && <span className="field-error">The passwords don't match.</span>}
        </label>
        <StatusLine status={status} />
        <button className="primary" disabled={busy || !current || !next || mismatch}>{busy ? 'Saving…' : 'Change password'}</button>
      </form>
    </Section>
  );
}

function DeleteForm({ onDeleted }: { onDeleted: () => void }) {
  const [password, setPassword] = useState('');
  const [understood, setUnderstood] = useState(false);
  const { status, run, busy } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api.deleteAccount(password);
      onDeleted();
      return 'Account deleted.';
    });
  };
  return (
    <Section title="Delete account" danger>
      <form onSubmit={submit} className="account-form">
        <p>
          This permanently deletes your account, every bill you've uploaded, its results, and its dispute letter.
          It can't be undone. Download any letters you want to keep first.
        </p>
        <label>
          Current password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <label className="check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          I understand this can't be undone
        </label>
        <StatusLine status={status} />
        <button className="danger-button" disabled={busy || !password || !understood}>{busy ? 'Deleting…' : 'Delete my account'}</button>
      </form>
    </Section>
  );
}

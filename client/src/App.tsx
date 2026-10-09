import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, isDemo, type User } from './api';
import AccountPage from './pages/AccountPage';
import AuthPage from './pages/AuthPage';
import BillPage from './pages/BillPage';
import Dashboard from './pages/Dashboard';

interface Session {
  user: User | null;
  setUser: (u: User | null) => void;
}
const SessionContext = createContext<Session>({ user: null, setUser: () => {} });
export const useSession = () => useContext(SessionContext);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    api.me().then(setUser).catch(() => setUser(null)).finally(() => setChecked(true));
  }, []);

  if (!checked) return null;
  return (
    <SessionContext.Provider value={{ user, setUser }}>
      <Header />
      <main className="page">
        <Routes>
          <Route path="/signin" element={user ? <Navigate to="/" replace /> : <AuthPage />} />
          <Route path="/" element={user ? <Dashboard /> : <Navigate to="/signin" replace />} />
          <Route path="/bills/:id" element={user ? <BillPage /> : <Navigate to="/signin" replace />} />
          <Route path="/account" element={user ? <AccountPage /> : <Navigate to="/signin" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </SessionContext.Provider>
  );
}

function Header() {
  const { user, setUser } = useSession();
  const navigate = useNavigate();
  return (
    <header className="masthead">
      <Link to="/" className="wordmark" aria-label="ClaimCheck home">
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <rect x="3" y="1.5" width="16" height="19" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
          <path d="M7 7h8M7 11h8M7 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          <path d="M13.5 15.5l1.6 1.6 3.4-3.6" stroke="var(--ok)" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        ClaimCheck
      </Link>
      {isDemo && <span className="demo-tag">Demo with a sample bill</span>}
      {user && (
        <nav className="masthead-nav" aria-label="Account">
          <NavLink to="/account" className="nav-link">Account</NavLink>
          <button
            className="link-button"
            onClick={async () => {
              await api.logout();
              setUser(null);
              navigate('/signin');
            }}
          >
            Sign out
          </button>
        </nav>
      )}
    </header>
  );
}

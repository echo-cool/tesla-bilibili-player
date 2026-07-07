import { useEffect, useState, type FormEvent } from 'react';
import { Link, Route, Routes, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { api, setOnLocked } from './api';
import { PasswordGate } from './components/PasswordGate';
import { Home } from './pages/Home';
import { SearchPage } from './pages/Search';
import { Login } from './pages/Login';
import { Watch } from './pages/Watch';

function TopBar() {
  const { loggedIn, user } = useAuth();
  const nav = useNavigate();
  const [q, setQ] = useState('');

  const onSearch = (e: FormEvent) => {
    e.preventDefault();
    const kw = q.trim();
    if (kw) nav(`/search?q=${encodeURIComponent(kw)}`);
  };

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        Tesla <b>哔哩</b>
      </Link>
      <form className="search-form" onSubmit={onSearch}>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Bilibili…"
          enterKeyHint="search"
        />
        <button className="btn" type="submit">
          Search
        </button>
      </form>
      {loggedIn && user ? (
        <img className="avatar" src={user.face} alt={user.uname} title={user.uname} referrerPolicy="no-referrer" />
      ) : (
        <Link to="/login" className="btn btn-accent">
          Log in
        </Link>
      )}
    </header>
  );
}

export function App() {
  const [gate, setGate] = useState<'checking' | 'locked' | 'open'>('checking');

  useEffect(() => {
    // Re-lock if any protected request later returns 401 (cookie expired).
    setOnLocked(() => setGate('locked'));
    api
      .gateStatus()
      .then((s) => setGate(s.unlocked ? 'open' : 'locked'))
      .catch(() => setGate('open')); // status endpoint failing shouldn't hard-lock
  }, []);

  if (gate === 'checking') {
    return (
      <div className="center">
        <div className="spinner" />
      </div>
    );
  }
  if (gate === 'locked') {
    return <PasswordGate onUnlocked={() => setGate('open')} />;
  }

  return (
    <AuthProvider>
      <div className="app">
        <TopBar />
        <main className="content">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/login" element={<Login />} />
            <Route path="/watch/:bvid" element={<Watch />} />
          </Routes>
        </main>
      </div>
    </AuthProvider>
  );
}

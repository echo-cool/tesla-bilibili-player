import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { VideoGrid } from '../components/VideoGrid';
import type { VideoCard } from '../types';

type TabKey = 'history' | 'following' | 'recommended' | 'popular';

interface TabDef {
  key: TabKey;
  label: string;
  needsLogin: boolean;
  load: () => Promise<VideoCard[]>;
}

const TABS: TabDef[] = [
  { key: 'history', label: 'Continue watching', needsLogin: true, load: () => api.history().then((r) => r.items) },
  { key: 'following', label: 'Following', needsLogin: true, load: () => api.following().then((r) => r.items) },
  { key: 'recommended', label: 'Recommended', needsLogin: false, load: () => api.feed().then((r) => r.items) },
  { key: 'popular', label: 'Popular', needsLogin: false, load: () => api.popular().then((r) => r.items) },
];

export function Home() {
  const { loggedIn, loading: authLoading } = useAuth();
  const [active, setActive] = useState<TabKey>('recommended');
  const [cache, setCache] = useState<Partial<Record<TabKey, VideoCard[]>>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const tab = TABS.find((t) => t.key === active)!;
  const gatedOut = tab.needsLogin && !loggedIn;

  useEffect(() => {
    if (authLoading || gatedOut) return;
    if (cache[active]) return; // already loaded this tab
    let alive = true;
    setLoading(true);
    setError('');
    tab
      .load()
      .then((items) => alive && setCache((c) => ({ ...c, [active]: items })))
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, loggedIn, authLoading]);

  const items = cache[active] ?? [];

  return (
    <>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={'tab' + (t.key === active ? ' active' : '')}
            onClick={() => setActive(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {gatedOut ? (
        <div className="center">
          <p className="muted">Log in with your Bilibili account to see this.</p>
          <Link to="/login" className="btn btn-accent">
            Log in
          </Link>
        </div>
      ) : loading ? (
        <div className="center">
          <div className="spinner" />
        </div>
      ) : error ? (
        <p className="muted">{error}</p>
      ) : items.length === 0 ? (
        <div className="center">
          <p className="muted">Nothing here yet.</p>
        </div>
      ) : (
        <VideoGrid items={items} />
      )}
    </>
  );
}

import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { VideoGrid } from '../components/VideoGrid';
import type { VideoCard } from '../types';

export function SearchPage() {
  const [params] = useSearchParams();
  const q = params.get('q') ?? '';
  const [items, setItems] = useState<VideoCard[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!q) return;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .search(q)
      .then((r) => alive && setItems(r.items))
      .catch((e) => alive && setError(String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [q]);

  return (
    <>
      <h2 className="section-title">Results for “{q}”</h2>
      {loading && (
        <div className="center">
          <div className="spinner" />
        </div>
      )}
      {error && <p className="muted">{error}</p>}
      {!loading && !error && <VideoGrid items={items} />}
    </>
  );
}

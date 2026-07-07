import { Link } from 'react-router-dom';
import type { VideoCard } from '../types';
import { formatDuration } from '../util';

function watchHref(v: VideoCard): string {
  const base = `/watch/${v.bvid}`;
  return v.progress ? `${base}?t=${Math.floor(v.progress)}` : base;
}

export function VideoGrid({ items }: { items: VideoCard[] }) {
  return (
    <div className="grid">
      {items.map((v) => {
        const pct =
          v.progress && v.duration ? Math.min(100, (v.progress / v.duration) * 100) : 0;
        return (
          <Link className="card" key={v.bvid} to={watchHref(v)}>
            <div className="thumb">
              {v.cover && <img src={v.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />}
              {v.duration ? <span className="dur">{formatDuration(v.duration)}</span> : null}
              {pct > 0 && (
                <span className="progress-bar">
                  <span className="progress-fill" style={{ width: `${pct}%` }} />
                </span>
              )}
            </div>
            <div className="meta">
              <div className="title">{v.title}</div>
              <div className="author">{v.author}</div>
            </div>
          </Link>
        );
      })}
    </div>
  );
}

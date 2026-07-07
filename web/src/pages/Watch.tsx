import { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Player } from '../components/Player';
import type { PlayUrl, VideoInfo, VideoPage } from '../types';

export function Watch() {
  const { bvid = '' } = useParams();
  const [params] = useSearchParams();
  const resumeAt = Number(params.get('t')) || 0; // e.g. from "continue watching"
  const [info, setInfo] = useState<VideoInfo | null>(null);
  const [pages, setPages] = useState<VideoPage[]>([]);
  const [cid, setCid] = useState<number | undefined>();
  const [play, setPlay] = useState<PlayUrl | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!bvid) return;
    let alive = true;
    setInfo(null);
    setPlay(null);
    setError('');
    api
      .video(bvid)
      .then((r) => {
        if (!alive) return;
        setInfo(r.info);
        setPages(r.pages);
        setCid(r.pages[0]?.cid);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [bvid]);

  useEffect(() => {
    if (!bvid || !cid) return;
    let alive = true;
    setPlay(null);
    api
      .playurl(bvid, cid)
      .then((r) => alive && setPlay(r))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [bvid, cid]);

  return (
    <div className="watch">
      {play ? (
        <Player
          playUrl={play}
          bvid={bvid}
          cid={cid}
          startAt={cid === pages[0]?.cid ? resumeAt : 0}
        />
      ) : (
        <div className="player-shell">
          <div className="center">
            <div className="spinner" />
          </div>
        </div>
      )}

      {error && <p className="muted">{error}</p>}

      {info && (
        <>
          <div className="watch-title">{info.title}</div>
          <div className="watch-sub">{info.author}</div>
        </>
      )}

      {pages.length > 1 && (
        <div className="parts">
          {pages.map((p) => (
            <button
              key={p.cid}
              className={'part-btn' + (p.cid === cid ? ' active' : '')}
              onClick={() => setCid(p.cid)}
            >
              {p.page}. {p.part}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

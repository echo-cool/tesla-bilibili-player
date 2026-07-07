import { useEffect, useMemo, useRef, useState } from 'react';
import { CanvasPlayer, type PlayerState } from '../player/CanvasPlayer';
import { api } from '../api';
import type { PlayUrl, Track } from '../types';
import { formatDuration } from '../util';

type Stats = ReturnType<CanvasPlayer['getStats']>;

function pickDefaultVideo(videos: Track[]): number | undefined {
  if (videos.length === 0) return undefined;
  const byHeight = [...videos].sort((a, b) => (b.height ?? 0) - (a.height ?? 0));
  const upTo1080 = byHeight.find((v) => (v.height ?? 0) <= 1080);
  return (upTo1080 ?? byHeight[0]).id;
}

const avc = (v: Track) => v.codecs.startsWith('avc');

interface PlayerProps {
  playUrl: PlayUrl;
  bvid: string;
  cid?: number;
  /** Resume position (seconds) for the initial load, e.g. from watch history. */
  startAt?: number;
}

export function Player({ playUrl, bvid, cid, startAt = 0 }: PlayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<CanvasPlayer | null>(null);
  const lastTimeRef = useRef(startAt);
  const firstLoadRef = useRef(true);

  // `pu` starts as the prop and is only replaced in place when a playurl refresh
  // is needed (expired links). New videos/parts remount this component entirely.
  const [pu, setPu] = useState(playUrl);
  const [state, setState] = useState<PlayerState>('idle');
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(playUrl.durationSec);
  // Always start at full volume — the car's system volume is the real control.
  const [volume, setVolume] = useState(1);
  const [videoId, setVideoId] = useState<number | undefined>(() =>
    pickDefaultVideo(playUrl.videos.filter(avc)),
  );
  const [err, setErr] = useState('');
  const [showStats, setShowStats] = useState(
    () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debug'),
  );
  const [stats, setStats] = useState<Stats | null>(null);

  // Only AVC video + AAC audio are guaranteed to decode via WebCodecs everywhere.
  const avcVideos = useMemo(() => pu.videos.filter(avc), [pu]);
  const audio = useMemo(() => {
    const aac = pu.audios.filter((a) => a.codecs.startsWith('mp4a'));
    return (aac.length ? aac : pu.audios).sort((a, b) => b.bandwidth - a.bandwidth)[0];
  }, [pu]);
  const qualityOptions = useMemo(
    () =>
      avcVideos.map((v) => ({
        id: v.id,
        label: pu.qualities.find((q) => q.id === v.id)?.label ?? `${v.height ?? v.id}p`,
      })),
    [avcVideos, pu],
  );

  // Create the engine once (per mount = per video/part).
  useEffect(() => {
    if (!canvasRef.current) return;
    if (!window.isSecureContext) {
      setErr(
        'Serve this site over HTTPS. On plain HTTP the browser disables WebCodecs and other secure APIs, so video cannot play. (localhost is exempt, which is why dev works.)',
      );
      setState('error');
      return;
    }
    if (!CanvasPlayer.isSupported()) {
      setErr('This browser lacks WebCodecs (VideoDecoder/AudioDecoder), which this player requires.');
      setState('error');
      return;
    }
    const player = new CanvasPlayer(canvasRef.current, {
      onTime: (t) => {
        lastTimeRef.current = t;
        setTime(t);
      },
      onDurationChange: setDuration,
      onStateChange: setState,
      onError: setErr,
      onExpired: () => {
        // Signed stream links expired — refetch playurl; the load effect below
        // reloads and resumes at the current position.
        api
          .playurl(bvid, cid)
          .then((fresh) => setPu(fresh))
          .catch((e) => setErr('Stream link expired and refresh failed: ' + String(e)));
      },
    });
    player.setVolume(volume);
    playerRef.current = player;
    return () => {
      player.destroy();
      playerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // (Re)load when the selected quality changes (videoId) or links refresh (pu).
  useEffect(() => {
    const player = playerRef.current;
    if (!player || videoId === undefined) return;
    const v = avcVideos.find((x) => x.id === videoId) ?? avcVideos[0];
    if (!v || !audio) {
      setErr('No AVC video track available for this video.');
      return;
    }
    const resumeTo = firstLoadRef.current ? startAt : lastTimeRef.current;
    firstLoadRef.current = false;
    let cancelled = false;
    (async () => {
      try {
        await player.load({
          videoUrl: v.url,
          videoBackupUrl: v.backupUrl,
          audioUrl: audio.url,
          audioBackupUrl: audio.backupUrl,
          durationSec: pu.durationSec,
        });
        if (!cancelled && resumeTo > 2) await player.seek(resumeTo);
      } catch (e) {
        if (!cancelled) setErr(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId, pu]);

  // Poll live stats while the overlay is visible.
  useEffect(() => {
    if (!showStats) {
      setStats(null);
      return;
    }
    const id = window.setInterval(() => {
      const p = playerRef.current;
      if (p) setStats(p.getStats());
    }, 500);
    return () => clearInterval(id);
  }, [showStats]);

  const onVolume = (v: number) => {
    setVolume(v);
    playerRef.current?.setVolume(v);
  };

  const onSeek = (t: number) => {
    setTime(t);
    void playerRef.current?.seek(t);
  };

  const toggleFullscreen = () => {
    const el = rootRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const playing = state === 'playing';
  const busy = state === 'buffering' || state === 'idle';
  const showPlayOverlay = (state === 'paused' || state === 'ended') && !err;

  return (
    <div className="player-block">
      <div className="player-shell">
        <div className="cplayer" ref={rootRef}>
          <canvas
            ref={canvasRef}
            className="cplayer-canvas"
            onClick={() => playerRef.current?.togglePlay()}
          />

          {showStats && stats && (
            <div className="cplayer-stats">
              <div>
                state <b>{stats.state}</b>
              </div>
              <div>
                render <b>{stats.renderFps} fps</b> · decode {stats.decodeFps} fps
              </div>
              <div>
                queue {stats.queued} · inDecode {stats.decodeQueue} · dropped {stats.dropped}
              </div>
              <div>
                buffer v{stats.bufferedVideoSec}s · a{stats.bufferedAudioSec}s
              </div>
              <div>
                {stats.resolution} {stats.codec}
              </div>
              <div>t {stats.currentSec}s</div>
            </div>
          )}

          {busy && !err && (
            <div className="cplayer-overlay">
              <div className="spinner" />
            </div>
          )}
          {showPlayOverlay && (
            <button
              className="cplayer-play-overlay"
              onClick={() => playerRef.current?.play()}
              aria-label={state === 'ended' ? 'Replay' : 'Play'}
            >
              <span>{state === 'ended' ? '↻' : '►'}</span>
            </button>
          )}
          {err && (
            <div className="cplayer-overlay cplayer-error">
              <p>{err}</p>
            </div>
          )}

          <div className="cplayer-controls">
            <button className="cplayer-btn" onClick={() => playerRef.current?.togglePlay()}>
              {playing ? '❚❚' : '►'}
            </button>
            <span className="cplayer-time">{formatDuration(time)}</span>
            <input
              className="cplayer-seek"
              type="range"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={Math.min(time, duration)}
              onChange={(e) => onSeek(Number(e.target.value))}
            />
            <span className="cplayer-time">{formatDuration(duration)}</span>

            <input
              className="cplayer-vol"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={volume}
              onChange={(e) => onVolume(Number(e.target.value))}
              aria-label="Volume"
            />

            <button
              className={'cplayer-btn' + (showStats ? ' cplayer-btn-on' : '')}
              onClick={() => setShowStats((s) => !s)}
              aria-label="Toggle stats"
              title="Playback stats"
            >
              ⓘ
            </button>
            <button className="cplayer-btn" onClick={toggleFullscreen} aria-label="Fullscreen">
              ⛶
            </button>
          </div>
        </div>
      </div>

      {/* Quality as plain buttons below the player — the Tesla browser can't
          open native <select> dropdowns reliably. */}
      {qualityOptions.length > 1 && (
        <div className="quality-row">
          <span className="quality-label">Quality</span>
          {qualityOptions.map((q) => (
            <button
              key={q.id}
              className={'part-btn' + (q.id === videoId ? ' active' : '')}
              onClick={() => setVideoId(q.id)}
            >
              {q.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

import type { PlayUrl, User, VideoCard, VideoInfo, VideoPage } from './types';

// Called when a protected request comes back 401 (gate locked / cookie expired),
// so the app can drop back to the password screen.
let lockedHandler: (() => void) | null = null;
export function setOnLocked(fn: () => void) {
  lockedHandler = fn;
}

async function get<T>(path: string): Promise<T> {
  // Cache-buster: the Tesla browser serves same-URL GETs from cache even for
  // fetch/XHR — a stale /auth/qr/poll response makes QR login never complete
  // in the car. (The server also sends Cache-Control: no-store on /api.)
  const url = `${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}`;
  const res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (res.status === 401) {
    lockedHandler?.();
    throw new Error('locked');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = JSON.stringify(await res.json());
    } catch {
      /* ignore */
    }
    throw new Error(`${res.status} ${res.statusText} ${detail}`);
  }
  return res.json() as Promise<T>;
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    lockedHandler?.();
    throw new Error('locked');
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

export const api = {
  // Site password gate
  gateStatus: () => get<{ required: boolean; unlocked: boolean }>('/api/gate/status'),
  gateLogin: async (password: string): Promise<boolean> => {
    // Own fetch so a wrong password (401) doesn't trip the global lock handler.
    const res = await fetch('/api/gate/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return res.ok;
  },

  authStatus: () => get<{ loggedIn: boolean; user: User | null }>('/api/auth/status'),
  loginQr: () => get<{ qrcodeKey: string; url: string }>('/api/auth/qr'),
  pollQr: (key: string) =>
    get<{ code: number; message: string; loggedIn: boolean; user?: User }>(
      `/api/auth/qr/poll?key=${encodeURIComponent(key)}`,
    ),
  logout: () => post<{ ok: true }>('/api/auth/logout'),

  feed: (page = 1) => get<{ items: VideoCard[] }>(`/api/feed?page=${page}`),
  popular: (page = 1) => get<{ items: VideoCard[] }>(`/api/popular?page=${page}`),
  following: (page = 1) => get<{ items: VideoCard[] }>(`/api/following?page=${page}`),
  history: () => get<{ items: VideoCard[] }>('/api/history'),
  search: (keyword: string, page = 1) =>
    get<{ items: VideoCard[]; numPages?: number }>(
      `/api/search?keyword=${encodeURIComponent(keyword)}&page=${page}`,
    ),

  video: (bvid: string) => get<{ info: VideoInfo; pages: VideoPage[] }>(`/api/video?bvid=${bvid}`),
  playurl: (bvid: string, cid?: number, qn?: number) => {
    const params = new URLSearchParams({ bvid });
    if (cid) params.set('cid', String(cid));
    if (qn) params.set('qn', String(qn));
    return get<PlayUrl>(`/api/playurl?${params.toString()}`);
  },
};

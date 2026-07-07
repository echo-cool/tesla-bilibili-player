import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';

export interface User {
  mid: number;
  uname: string;
  face: string;
}

export interface BiliSession {
  id: string;
  /** Bilibili cookies we replay on API/CDN requests (SESSDATA, bili_jct, buvid3, …). */
  cookies: Record<string, string>;
  user: User | null;
  createdAt: number;
}

const SID_COOKIE = 'sid';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

// In-memory session store. Fine for a personal single-user deployment; swap for
// a persistent store if you need sessions to survive restarts.
const store = new Map<string, BiliSession>();
const MAX_SESSIONS = 5000;

/** Keep the store from growing unbounded (bots create anonymous sessions). */
function evictIfNeeded(): void {
  if (store.size <= MAX_SESSIONS) return;
  const byAge = [...store.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  for (const [id, sess] of byAge) {
    if (store.size <= MAX_SESSIONS * 0.8) break;
    if (!sess.user) store.delete(id); // prefer dropping anonymous sessions
  }
}

export function getSession(req: Request, res: Response): BiliSession {
  const existingId = req.signedCookies?.[SID_COOKIE] as string | undefined;
  const existing = existingId ? store.get(existingId) : undefined;
  if (existing) return existing;

  evictIfNeeded();
  const id = randomBytes(18).toString('hex');
  const sess: BiliSession = { id, cookies: {}, user: null, createdAt: Date.now() };
  store.set(id, sess);
  res.cookie(SID_COOKIE, id, {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    maxAge: MAX_AGE_MS,
  });
  return sess;
}

export function clearSession(req: Request, res: Response): void {
  const id = req.signedCookies?.[SID_COOKIE] as string | undefined;
  if (id) store.delete(id);
  res.clearCookie(SID_COOKIE);
}

export function cookieHeader(sess: BiliSession): string {
  return Object.entries(sess.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

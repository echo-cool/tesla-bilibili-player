import { Router, type NextFunction, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

const GATE_COOKIE = 'gate';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180 days

function passwordMatches(input: string): boolean {
  const a = Buffer.from(input);
  const b = Buffer.from(config.sitePassword);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function unlocked(req: Request): boolean {
  return req.signedCookies?.[GATE_COOKIE] === 'ok';
}

/** Blocks protected routes until the site password has been entered. */
export function gateGuard(req: Request, res: Response, next: NextFunction) {
  if (!config.sitePassword) return next(); // gate disabled
  if (unlocked(req)) return next();
  res.status(401).json({ error: 'locked' });
}

export const gateRouter = Router();

gateRouter.get('/status', (req, res) => {
  const required = !!config.sitePassword;
  res.json({ required, unlocked: !required || unlocked(req) });
});

gateRouter.post('/login', (req, res) => {
  if (!config.sitePassword) {
    res.json({ ok: true });
    return;
  }
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!passwordMatches(password)) {
    res.status(401).json({ ok: false });
    return;
  }
  res.cookie(GATE_COOKIE, 'ok', {
    httpOnly: true,
    sameSite: 'lax',
    signed: true,
    secure: config.isProd,
    maxAge: MAX_AGE_MS,
  });
  res.json({ ok: true });
});

gateRouter.post('/logout', (_req, res) => {
  res.clearCookie(GATE_COOKIE);
  res.json({ ok: true });
});

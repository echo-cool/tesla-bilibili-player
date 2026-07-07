import { Router } from 'express';
import { getSession, clearSession } from '../bili/session.js';
import * as bili from '../bili/client.js';
import { log } from '../log.js';

export const apiRouter = Router();

function fail(res: import('express').Response, err: unknown) {
  const msg = String(err instanceof Error ? err.message : err);
  log('error', 'api', `${res.req.method} ${res.req.originalUrl} failed: ${msg}`);
  res.status(502).json({ error: msg });
}

// ---------- client log ingestion ----------
// The player reports its events here so in-car problems (no devtools in the
// Tesla browser) show up in `docker compose logs`.

interface ClientEvent {
  level?: string;
  tag?: string;
  msg?: string;
}

apiRouter.post('/log', (req, res) => {
  const events: ClientEvent[] = Array.isArray(req.body?.events) ? req.body.events : [];
  const ua = (req.header('user-agent') || '').slice(0, 80);
  for (const e of events.slice(0, 50)) {
    const lvl = e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info';
    log(lvl, 'client', `[${String(e.tag ?? 'player').slice(0, 32)}] ${String(e.msg ?? '').slice(0, 500)}`, {
      ip: req.ip,
      ua,
    });
  }
  res.json({ ok: true });
});

// ---------- auth ----------

apiRouter.get('/auth/status', async (req, res) => {
  const sess = getSession(req, res);
  try {
    // Revalidate against Bilibili so an expired cookie reflects as logged-out.
    if (Object.keys(sess.cookies).some((k) => k === 'SESSDATA')) {
      await bili.refreshUser(sess);
    }
  } catch {
    /* ignore; fall through with cached state */
  }
  res.json({ loggedIn: !!sess.user, user: sess.user });
});

apiRouter.get('/auth/qr', async (req, res) => {
  const sess = getSession(req, res);
  try {
    res.json(await bili.getQr(sess));
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/auth/qr/poll', async (req, res) => {
  const sess = getSession(req, res);
  const key = req.query.key;
  if (typeof key !== 'string') {
    res.status(400).json({ error: 'missing key' });
    return;
  }
  try {
    const r = await bili.pollQr(sess, key);
    res.json({ code: r.code, message: r.message, loggedIn: !!r.user, user: r.user ?? undefined });
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.post('/auth/logout', (req, res) => {
  clearSession(req, res);
  res.json({ ok: true });
});

// ---------- browse ----------

apiRouter.get('/feed', async (req, res) => {
  const sess = getSession(req, res);
  const page = Number(req.query.page) || 1;
  try {
    res.json({ items: await bili.feed(sess, page) });
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/history', async (req, res) => {
  const sess = getSession(req, res);
  try {
    res.json({ items: await bili.history(sess) });
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/following', async (req, res) => {
  const sess = getSession(req, res);
  const page = Number(req.query.page) || 1;
  try {
    res.json({ items: await bili.following(sess, page) });
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/popular', async (req, res) => {
  const sess = getSession(req, res);
  const page = Number(req.query.page) || 1;
  try {
    res.json({ items: await bili.popular(sess, page) });
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/search', async (req, res) => {
  const sess = getSession(req, res);
  const keyword = req.query.keyword;
  if (typeof keyword !== 'string' || !keyword.trim()) {
    res.status(400).json({ error: 'missing keyword' });
    return;
  }
  const page = Number(req.query.page) || 1;
  try {
    res.json({ items: await bili.search(sess, keyword.trim(), page) });
  } catch (e) {
    fail(res, e);
  }
});

// ---------- video + playback ----------

apiRouter.get('/video', async (req, res) => {
  const sess = getSession(req, res);
  const bvid = req.query.bvid;
  if (typeof bvid !== 'string' || !bvid) {
    res.status(400).json({ error: 'missing bvid' });
    return;
  }
  try {
    res.json(await bili.videoInfo(sess, bvid));
  } catch (e) {
    fail(res, e);
  }
});

apiRouter.get('/playurl', async (req, res) => {
  const sess = getSession(req, res);
  const bvid = req.query.bvid;
  if (typeof bvid !== 'string' || !bvid) {
    res.status(400).json({ error: 'missing bvid' });
    return;
  }
  let cid = Number(req.query.cid) || 0;
  const qn = Number(req.query.qn) || 80;
  try {
    if (!cid) {
      // Resolve the first page's cid if the caller didn't supply one.
      const { pages } = await bili.videoInfo(sess, bvid);
      cid = pages[0]?.cid ?? 0;
    }
    if (!cid) {
      res.status(404).json({ error: 'no cid for video' });
      return;
    }
    res.json(await bili.playurl(sess, bvid, cid, qn));
  } catch (e) {
    fail(res, e);
  }
});

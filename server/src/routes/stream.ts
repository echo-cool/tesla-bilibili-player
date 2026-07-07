import { Router, type Request, type Response, type RequestHandler } from 'express';
import { config } from '../config.js';
import { log } from '../log.js';

export const streamRouter = Router();

/** Abort the upstream fetch only after it delivers NO data for this long
 *  (inactivity, not total duration) so slow-but-progressing downloads survive. */
const IDLE_TIMEOUT_MS = 25_000;

function makeHostCheck(allow: string[]) {
  return (hostname: string): boolean => {
    const h = hostname.toLowerCase();
    return allow.some((suffix) => h === suffix.replace(/^\./, '') || h.endsWith(suffix));
  };
}

/**
 * Generic upstream proxy. Adds the Bilibili Referer/UA that the CDN requires,
 * forwards Range requests, and re-emits the response same-origin (so the canvas
 * player and <img> tags work under cross-origin isolation without CORP issues).
 */
function makeProxy(
  label: string,
  allow: string[],
  copyHeaders: string[],
  noStore = false,
): RequestHandler {
  const hostAllowed = makeHostCheck(allow);
  return async (req: Request, res: Response) => {
    const started = Date.now();
    const raw = req.query.url;
    if (typeof raw !== 'string' || !raw) {
      res.status(400).json({ error: 'missing url' });
      return;
    }

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      log('warn', label, `invalid url: ${raw.slice(0, 120)}`);
      res.status(400).json({ error: 'invalid url' });
      return;
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      res.status(400).json({ error: 'unsupported protocol' });
      return;
    }
    if (!hostAllowed(target.hostname)) {
      log('warn', label, `host not allowed: ${target.hostname}`);
      res.status(403).json({ error: 'host not allowed', host: target.hostname });
      return;
    }

    const upstreamHeaders: Record<string, string> = {
      'User-Agent': config.userAgent,
      Referer: config.biliReferer,
      Origin: config.biliReferer,
      Accept: '*/*',
    };
    const range = req.header('range');
    if (range) upstreamHeaders['Range'] = range;

    // Abort on client disconnect, or when the upstream goes idle (no bytes for
    // IDLE_TIMEOUT_MS). The idle timer resets on every chunk, so a slow but
    // progressing transfer is never killed — only a genuinely hung connection.
    const controller = new AbortController();
    let timedOut = false;
    let clientGone = false;
    const onClientClose = () => {
      clientGone = true;
      controller.abort();
    };
    req.on('close', onClientClose);
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, IDLE_TIMEOUT_MS);
    };
    armIdle();

    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target.toString(), {
        headers: upstreamHeaders,
        signal: controller.signal,
        redirect: 'follow',
      });
    } catch (err) {
      clearTimeout(idleTimer);
      if (clientGone) {
        log('debug', label, `client aborted before upstream response ${target.hostname}`);
        return;
      }
      log('error', label, `upstream ${timedOut ? 'idle-timeout' : 'fetch failed'} ${target.hostname}`, {
        range,
        ms: Date.now() - started,
        err: String(err),
      });
      res.status(timedOut ? 504 : 502).json({ error: 'upstream fetch failed', detail: String(err) });
      return;
    }
    armIdle(); // reset now that headers arrived

    res.status(upstream.status);
    for (const h of copyHeaders) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    // Never let a CDN (e.g. Cloudflare) cache the stream: on a cache miss it
    // fetches the WHOLE file from us without a Range, which stalls/times out.
    if (noStore) res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Timing-Allow-Origin', '*');

    if (upstream.status >= 400) {
      log('warn', label, `upstream ${upstream.status} ${target.hostname}`, { range });
    }

    if (!upstream.body) {
      clearTimeout(idleTimer);
      res.end();
      return;
    }

    let sent = 0;
    try {
      const reader = upstream.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          armIdle(); // progress — reset the idle timer
          sent += value.byteLength;
          if (!res.write(Buffer.from(value))) {
            await new Promise<void>((r) => res.once('drain', r));
          }
        }
      }
      clearTimeout(idleTimer);
      res.end();
      log('info', label, `${target.hostname} ${upstream.status} sent=${sent}B ${Date.now() - started}ms`, {
        range,
      });
    } catch (err) {
      clearTimeout(idleTimer);
      if (clientGone) {
        log('debug', label, `client aborted mid-stream ${target.hostname} sent=${sent}B`);
      } else {
        log('error', label, `stream ${timedOut ? 'idle-timeout' : 'error'} ${target.hostname} sent=${sent}B`, {
          range,
          err: String(err),
        });
        res.destroy(err as Error);
      }
    }
  };
}

const MEDIA_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  // NOTE: 'cache-control' deliberately omitted — we force no-store below so a
  // fronting CDN never tries to cache (and full-file-fetch) the stream.
];
const IMG_HEADERS = ['content-type', 'content-length', 'cache-control', 'etag', 'last-modified'];

// GET /api/stream?url=<encoded>  — DASH video/audio segments (never cache: no-store)
streamRouter.get('/stream', makeProxy('proxy:stream', config.streamHostAllow, MEDIA_HEADERS, true));

// GET /api/img?url=<encoded>  — thumbnails / avatars (cacheable — small, static)
streamRouter.get('/img', makeProxy('proxy:img', config.imgHostAllow, IMG_HEADERS));

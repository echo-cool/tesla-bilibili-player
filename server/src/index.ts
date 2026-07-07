import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { streamRouter } from './routes/stream.js';
import { apiRouter } from './routes/api.js';
import { gateRouter, gateGuard } from './routes/gate.js';
import { log } from './log.js';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Request log. Stream/img proxy requests are logged with more detail inside the
// proxy itself, so skip them here to avoid double lines.
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') || req.path === '/api/stream' || req.path === '/api/img') {
    return next();
  }
  const start = Date.now();
  res.on('finish', () => {
    log('info', 'http', `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  next();
});

// Cross-origin isolation so SharedArrayBuffer (libmedia threaded WASM decode) works.
if (config.coep !== 'off') {
  app.use((_req, res, next) => {
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', config.coep);
    next();
  });
}

app.use(cookieParser(config.sessionSecret));
app.use(express.json());

// The Tesla browser serves same-URL GETs (even fetch/XHR) from cache unless
// told not to — a cached /api/auth/qr/poll or /api/auth/status response makes
// QR login never complete in the car. Images keep their upstream caching;
// /api/stream already forces no-store itself.
app.use('/api', (req, res, next) => {
  if (!req.path.startsWith('/img')) res.setHeader('Cache-Control', 'no-store');
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));
// Gate: /api/gate/* is open (status + login); everything else under /api is
// blocked until the site password is entered.
app.use('/api/gate', gateRouter);
app.use('/api', gateGuard);
app.use('/api', streamRouter);
app.use('/api', apiRouter);

// Serve the built frontend (production) with SPA fallback.
if (existsSync(config.webDist)) {
  app.use(express.static(config.webDist));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api/')) return next();
    res.sendFile(join(config.webDist, 'index.html'));
  });
} else {
  // eslint-disable-next-line no-console
  console.warn(`[web] built frontend not found at ${config.webDist} (dev mode: use the Vite server)`);
}

app.listen(config.port, () => {
  log('info', 'server', `listening on :${config.port} (COEP=${config.coep}, gate=${config.sitePassword ? 'on' : 'off'})`);
});

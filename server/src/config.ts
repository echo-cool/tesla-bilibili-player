import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  port: envInt('PORT', 8080),

  /** Where the built Vite frontend lives (served as static files in production). */
  webDist: process.env.WEB_DIST
    ? resolve(process.env.WEB_DIST)
    : resolve(__dirname, '../../web/dist'),

  /**
   * Cross-Origin-Embedder-Policy mode. libmedia's software (WASM+threads) decode
   * path needs SharedArrayBuffer, which requires cross-origin isolation
   * (COOP: same-origin + a COEP value). We proxy every cross-origin subresource
   * (streams + images) to same-origin, so 'require-corp' works on older Chromium.
   *   'require-corp'   - classic, most widely supported (default)
   *   'credentialless' - more forgiving for un-proxied cross-origin resources
   *   'off'            - disable isolation (SharedArrayBuffer unavailable)
   */
  coep: (process.env.COEP as 'require-corp' | 'credentialless' | 'off') || 'require-corp',

  /**
   * Desktop UA used for all Bilibili API + CDN requests. The stream CDN and some
   * endpoints reject unknown/mobile agents.
   */
  userAgent:
    process.env.BILI_UA ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',

  /** Required Referer for *.bilivideo.com stream fetches. */
  biliReferer: 'https://www.bilibili.com',

  /**
   * SSRF allow-list for the stream proxy: only hosts ending with one of these
   * suffixes may be proxied. Covers Bilibili's PCDN/CDN domains.
   */
  streamHostAllow: (
    process.env.STREAM_HOST_ALLOW ||
    '.bilivideo.com,.bilivideo.cn,.akamaized.net,.hdslb.com,.mcdn.bilivideo.cn'
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** SSRF allow-list for the image proxy (thumbnails/avatars). */
  imgHostAllow: (process.env.IMG_HOST_ALLOW || '.hdslb.com,.bilibili.com')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  /** Secret used to sign the session cookie. Change in production via env. */
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',

  /**
   * Optional site password (in-app login gate). When set, all data/stream
   * endpoints require a valid gate cookie obtained by POSTing this password to
   * /api/gate/login. Empty = no gate (open access).
   */
  sitePassword: process.env.SITE_PASSWORD || '',

  isProd: process.env.NODE_ENV === 'production',
};

export type AppConfig = typeof config;

# Tesla Bilibili Player

**English** | [简体中文](README.zh-CN.md)

Watch **Bilibili** in the **Tesla in-car browser** — with your own account, at full
quality, and **without the picture freezing when the car leaves Park**.

Tesla's browser freezes/blocks `<video>` elements once the car is in motion. This app
sidesteps that the same way [tesla-player.com](https://tesla-player.com) does: it never
uses a `<video>` element. The backend resolves Bilibili's DASH stream, and the frontend
**demuxes + decodes it with WebCodecs and paints frames onto a `<canvas>`**, with audio
via the **Web Audio API**. To the car, that looks like an ordinary animated page plus app
audio — which is not restricted — so playback keeps running.

> ⚠️ **Safety & use.** This defeats a driving-safety feature. Use it as a **passenger**,
> not while driving. It's intended for personal use with your own Bilibili account. You
> are responsible for how you use it.

## Features

- 🚗 **Plays while the car is in motion** — canvas + WebCodecs rendering, no `<video>` element
- 📱 **QR-code login** — scan with the Bilibili mobile app; unlocks your feed, history, and higher qualities (anonymous browsing works too, capped at 360p/480p)
- 🔍 **Browse like the real site** — recommended feed, search, and watch history
- 🎚️ **Quality switching**, play/pause, seeking, volume, fullscreen — all canvas-native, none of it trips the in-motion lock
- 🔐 **Optional site password** — an in-app gate that protects the API and streams server-side, not just the UI
- 🐳 **One-command HTTPS deploy** — Docker Compose with a bundled Caddy that auto-provisions Let's Encrypt certificates

## How it works

```
                Tesla in-car browser (Chromium)
        ┌───────────────────────────────────────────┐
        │  React app  ──►  CanvasPlayer               │
        │                   • mp4box.js demux (fMP4)  │
        │                   • WebCodecs VideoDecoder ─┼──► <canvas>   (no <video>!)
        │                   • WebCodecs AudioDecoder ─┼──► Web Audio
        └───────────────▲───────────────────────────┘
                        │ HTTPS (same-origin)
        ┌───────────────┴───────────────────────────┐
        │  Node/Express backend                       │
        │   • Bilibili web API (WBI-signed)           │
        │   • QR login → session cookies              │
        │   • search / feed / history / video info    │
        │   • playurl → DASH (video+audio URLs)       │
        │   • /api/stream + /api/img  (CDN proxy;     │
        │     adds Referer, fixes CORS, Range support)│
        └─────────────────────────────────────────────┘
```

- **Only AVC (H.264) video + AAC audio** tracks are used, because those decode via WebCodecs
  on every Chromium. Bilibili always offers them alongside HEVC/AV1/FLAC.
- The backend proxies **all** cross-origin bytes (stream segments *and* thumbnails) so the
  page is fully same-origin — required both because the Bilibili CDN checks `Referer` and to
  stay compatible with cross-origin isolation.

## Project layout

```
server/   Node + Express + TypeScript backend (Bilibili API, WBI signing, stream proxy)
web/      React + Vite + TypeScript frontend (browse UI + canvas player)
Dockerfile, docker-compose*.yml, Caddyfile   Deployment
```

## Requirements

- Node.js 20+ (22 recommended) for local dev, or Docker for deploy.
- A host reachable from the car over **HTTPS** (see [Deploy](#deploy-docker--vps)).
- A Bilibili account (optional — anonymous browsing works but is capped at 360p/480p).

---

## Local development

Run the backend and the Vite dev server in two terminals:

```bash
# terminal 1 — backend on :8080
cd server
npm install
npm run dev

# terminal 2 — frontend on :5173 (proxies /api to :8080)
cd web
npm install
npm run dev
```

Open http://localhost:5173. Note: **WebCodecs requires a Chromium browser** (Chrome/Edge);
playback won't work in Firefox/Safari desktop.

## Production build (single server)

The backend serves the built frontend, so you only run one process:

```bash
cd web && npm install && npm run build      # outputs web/dist
cd ../server && npm install && npm start     # serves API + web/dist on :8080
```

Open http://localhost:8080.

---

## Deploy (Docker → VPS)

```bash
# build + run
docker compose up -d --build
# app is now on :8080
```

Or plain Docker:

```bash
docker build -t tesla-bili-player .
docker run -d -p 8080:8080 -e SESSION_SECRET=$(openssl rand -hex 32) tesla-bili-player
```

### HTTPS is required

The player uses **WebCodecs**, which browsers only expose in a **secure context**
(HTTPS, or `localhost`). Served over plain HTTP it silently fails — video never plays.
The Tesla browser also requires HTTPS. So a real deployment must be HTTPS.

#### Turnkey HTTPS with `docker-compose.https.yml` (recommended)

This bundles a **Caddy** reverse proxy that fetches and renews Let's Encrypt certs
automatically. On the target server:

```bash
# 1. Point your domain's DNS A/AAAA record at this server, open ports 80 + 443.
# 2. Configure:
cp .env.example .env         # set DOMAIN, ACME_EMAIL
echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env
# 3. Launch:
docker compose -f docker-compose.https.yml up -d --build
```

Then browse to `https://<your-domain>` (first load waits ~10s while the cert is
issued). Only Caddy's 80/443 are exposed; the app stays internal.

#### Password-protect the site (optional)

Set `SITE_PASSWORD` and the app shows an in-page password screen before anyone can
browse or watch (a signed cookie remembers it afterward). This is an in-app login —
no browser Basic Auth dialog — so it works reliably in the Tesla browser.

```bash
echo "SITE_PASSWORD=your-password-here" >> .env
docker compose -f docker-compose.https.yml up -d
```

All data and stream endpoints (`/api/*`) are gated server-side, so the password
genuinely protects playback, not just the UI. Leave `SITE_PASSWORD` empty for open access.

#### Already run a reverse proxy? (ports 80/443 in use)

If the server already terminates TLS for other services, don't run the bundled
Caddy (it will fail with `bind: address already in use`). Run **app-only** and add
a vhost to your existing proxy:

```bash
echo "SESSION_SECRET=$(openssl rand -hex 32)" > .env
docker compose -f docker-compose.behind-proxy.yml up -d --build   # app on 127.0.0.1:8080
```

Existing **Caddy**:

```
player.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Existing **Nginx** (inside your `server { listen 443 ssl; server_name player.example.com; … }`):

```
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Forwarded-Proto https;
}
```

#### Other options

- **Cloudflare Tunnel** — no open ports; map a hostname to `http://localhost:8080`.
  Quick test URL: `cloudflared tunnel --url http://localhost:8080`.

### Environment variables

| Var                 | Default            | Purpose                                                        |
| ------------------- | ------------------ | -------------------------------------------------------------- |
| `PORT`              | `8080`             | Listen port                                                    |
| `SESSION_SECRET`    | dev secret         | **Set to a long random string in prod** (cookie signing)       |
| `SITE_PASSWORD`     | *(empty)*          | Optional in-app password gate; empty = open access             |
| `COEP`              | `require-corp`     | Cross-origin isolation: `require-corp` / `credentialless` / `off` (compose files default to `off`) |
| `LOG_LEVEL`         | `info`             | Log verbosity: `debug` / `info` / `warn` / `error`             |
| `BILI_UA`           | Chrome UA          | User-Agent used for Bilibili requests                          |
| `STREAM_HOST_ALLOW` | Bilibili CDN hosts | SSRF allow-list (host suffixes) for the stream proxy           |
| `IMG_HOST_ALLOW`    | Bilibili img hosts | SSRF allow-list (host suffixes) for the image proxy            |
| `WEB_DIST`          | `../web/dist`      | Path to built frontend                                         |

`COEP` isn't needed by this player (WebCodecs doesn't use SharedArrayBuffer), and
everything is proxied same-origin so it's harmless either way; use `COEP=off` if the
car's browser ever objects.

---

## Using it in the car

1. Browse to your HTTPS URL in the Tesla browser (bookmark it).
2. **Log in** (top-right) — a QR code appears; scan it with the Bilibili mobile app and
   confirm. Your feed, watch history, and higher qualities unlock. (You can also browse
   signed out.)
3. Pick a video from the **Recommended** feed, your **history**, or **search**.
4. On the watch page it plays in the canvas player. **Tap the video once to start** (browsers
   require a tap before audio can play).

**Controls:** tap to play/pause · scrub bar · volume · quality buttons below the player
(higher qualities when signed in) · fullscreen (⛶). Because it's a canvas, none of this
trips the in-motion lock.

---

## Limitations & notes

- **Chromium only** — needs WebCodecs (`VideoDecoder`/`AudioDecoder`). The Tesla browser is
  Chromium, so it works there; desktop Firefox/Safari won't.
- **AVC + AAC only** for now. HEVC/AV1/FLAC tracks are ignored (WebCodecs support for those
  is inconsistent). Every normal Bilibili video still plays.
- **No DRM.** Fine for regular user videos; DRM-protected content won't play.
- **Sessions are in-memory** — a backend restart logs you out (just re-scan). Swap the store
  in `server/src/bili/session.ts` if you want persistence.
- Seeking to a new position **re-buffers for a second or two**.
- This is unofficial and uses Bilibili's web API; endpoints/signing can change over time.

## Roadmap

- YouTube support via a `yt-dlp`-backed extractor (same canvas player).
- HEVC/AV1 playback where the browser supports it.
- Persistent sessions; multi-user.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — you are free to use, modify, and share this
project for any **noncommercial** purpose. Commercial use is not permitted.

> Required Notice: Copyright (c) 2026 Yuyang Wang

## Disclaimer

This project is not affiliated with Tesla or Bilibili. It uses Bilibili's public web API
with your own account, the same way the website does. Content rights belong to their
owners; don't use this to redistribute streams. Drive safely.

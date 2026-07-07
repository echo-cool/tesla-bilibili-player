import { config } from '../config.js';
import { encWbi, keyFromUrl } from './wbi.js';
import { cookieHeader, type BiliSession, type User } from './session.js';
import { log } from '../log.js';

const API = 'https://api.bilibili.com';
const PASSPORT = 'https://passport.bilibili.com';

// ---------- shared response shapes (mirror web/src/types.ts) ----------

export interface VideoCard {
  bvid: string;
  aid?: number;
  cid?: number;
  title: string;
  cover: string;
  author: string;
  authorMid?: number;
  duration?: number;
  views?: number;
  progress?: number; // seconds watched (history)
}

export interface VideoPage {
  cid: number;
  page: number;
  part: string;
  duration: number;
}

export interface VideoInfo {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  cover: string;
  author: string;
  authorMid: number;
  duration: number;
}

export interface Track {
  url: string;
  backupUrl?: string;
  codecs: string;
  mimeType: string;
  bandwidth: number;
  id: number;
  width?: number;
  height?: number;
  frameRate?: string;
}

export interface PlayUrl {
  videos: Track[];
  audios: Track[];
  qualities: { id: number; label: string }[];
  currentQn: number;
  durationSec: number;
}

// ---------- low-level helpers ----------

function baseHeaders(sess?: BiliSession): Record<string, string> {
  const h: Record<string, string> = {
    'User-Agent': config.userAgent,
    Referer: 'https://www.bilibili.com',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
  };
  if (sess) {
    const c = cookieHeader(sess);
    if (c) h.Cookie = c;
  }
  return h;
}

interface BiliEnvelope<T> {
  code: number;
  message: string;
  data: T;
}

async function apiGet<T = unknown>(url: string, sess?: BiliSession): Promise<BiliEnvelope<T>> {
  const started = Date.now();
  const path = url.split('?')[0];
  let res: globalThis.Response;
  try {
    res = await fetch(url, { headers: baseHeaders(sess), signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    log('error', 'bili', `${path} network error ${Date.now() - started}ms`, { err: String(err) });
    throw err;
  }
  const json = (await res.json()) as BiliEnvelope<T>;
  if (json.code !== 0) {
    // Non-zero codes are Bilibili-side rejections (risk control, auth, region…)
    // — exactly the kind of thing we need visible in server logs.
    log('warn', 'bili', `${path} code=${json.code} msg=${json.message} http=${res.status} ${Date.now() - started}ms`);
  } else {
    log('debug', 'bili', `${path} ok ${Date.now() - started}ms`);
  }
  return json;
}

/** Normalize a `//host/path` or `http://` cover URL and route it through our image proxy. */
function imgProxy(u?: string): string {
  if (!u) return '';
  const abs = u.startsWith('//') ? `https:${u}` : u.replace(/^http:/, 'https:');
  return `/api/img?url=${encodeURIComponent(abs)}`;
}

/** Route a DASH stream URL through our stream proxy (adds Referer, fixes CORS). */
function streamProxy(u: string): string {
  return `/api/stream?url=${encodeURIComponent(u)}`;
}

// ---------- WBI keys (cached) ----------

let wbiCache: { imgKey: string; subKey: string; ts: number } | null = null;

async function getWbiKeys(sess?: BiliSession): Promise<{ imgKey: string; subKey: string }> {
  if (wbiCache && Date.now() - wbiCache.ts < 6 * 3600 * 1000) return wbiCache;
  const json = await apiGet<{ wbi_img: { img_url: string; sub_url: string } }>(
    `${API}/x/web-interface/nav`,
    sess,
  );
  const imgKey = keyFromUrl(json.data?.wbi_img?.img_url ?? '');
  const subKey = keyFromUrl(json.data?.wbi_img?.sub_url ?? '');
  wbiCache = { imgKey, subKey, ts: Date.now() };
  return wbiCache;
}

/** Fetch anonymous buvid cookies (needed by search/wbi to avoid -412 risk control). */
export async function ensureBuvid(sess: BiliSession): Promise<void> {
  if (sess.cookies.buvid3) return;
  try {
    const json = await apiGet<{ b_3: string; b_4: string }>(`${API}/x/frontend/finger/spi`, sess);
    if (json.data?.b_3) sess.cookies.buvid3 = json.data.b_3;
    if (json.data?.b_4) sess.cookies.buvid4 = json.data.b_4;
  } catch {
    /* best effort */
  }
}

// ---------- auth ----------

export async function getQr(sess: BiliSession): Promise<{ url: string; qrcodeKey: string }> {
  const json = await apiGet<{ url: string; qrcode_key: string }>(
    `${PASSPORT}/x/passport-login/web/qrcode/generate`,
    sess,
  );
  return { url: json.data.url, qrcodeKey: json.data.qrcode_key };
}

const CAPTURE_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'sid'];

export async function pollQr(
  sess: BiliSession,
  key: string,
): Promise<{ code: number; message: string; user: User | null }> {
  const res = await fetch(
    `${PASSPORT}/x/passport-login/web/qrcode/poll?qrcode_key=${encodeURIComponent(key)}`,
    { headers: baseHeaders(sess) },
  );
  const setCookies = res.headers.getSetCookie?.() ?? [];
  const json = (await res.json()) as BiliEnvelope<{ code: number; message: string }>;
  const code = json.data?.code ?? -1;

  if (code === 0) {
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (CAPTURE_COOKIES.includes(name)) sess.cookies[name] = value;
    }
    await refreshUser(sess);
  }
  return { code, message: json.data?.message ?? '', user: sess.user };
}

export async function refreshUser(sess: BiliSession): Promise<User | null> {
  const json = await apiGet<{ isLogin: boolean; mid: number; uname: string; face: string }>(
    `${API}/x/web-interface/nav`,
    sess,
  );
  sess.user = json.data?.isLogin
    ? { mid: json.data.mid, uname: json.data.uname, face: imgProxy(json.data.face) }
    : null;
  return sess.user;
}

// ---------- browse ----------

interface RcmdItem {
  bvid?: string;
  id?: number;
  aid?: number;
  cid?: number;
  title: string;
  pic: string;
  owner?: { name: string; mid: number };
  duration?: number;
  stat?: { view: number };
}

export async function feed(sess: BiliSession, page = 1): Promise<VideoCard[]> {
  await ensureBuvid(sess);
  const { imgKey, subKey } = await getWbiKeys(sess);
  const q = encWbi(
    { fresh_type: 3, ps: 30, fresh_idx: page, fresh_idx_1h: page, feed_version: 'V8', web_location: 1430650 },
    imgKey,
    subKey,
  );
  const json = await apiGet<{ item: RcmdItem[] }>(
    `${API}/x/web-interface/wbi/index/top/feed/rcmd?${q}`,
    sess,
  );
  return (json.data?.item ?? [])
    .filter((i) => i.bvid)
    .map((i) => ({
      bvid: i.bvid!,
      aid: i.id,
      cid: i.cid,
      title: i.title,
      cover: imgProxy(i.pic),
      author: i.owner?.name ?? '',
      authorMid: i.owner?.mid,
      duration: i.duration,
      views: i.stat?.view,
    }));
}

interface HistoryItem {
  title: string;
  cover: string;
  author_name: string;
  duration: number;
  progress: number; // seconds watched, -1 when finished
  history: { bvid: string; cid: number; business: string };
}

export async function history(sess: BiliSession): Promise<VideoCard[]> {
  const json = await apiGet<{ list: HistoryItem[] }>(
    `${API}/x/web-interface/history/cursor?ps=30`,
    sess,
  );
  return (json.data?.list ?? [])
    .filter((i) => i.history?.bvid && i.history.business === 'archive')
    .map((i) => ({
      bvid: i.history.bvid,
      cid: i.history.cid,
      title: i.title,
      cover: imgProxy(i.cover),
      author: i.author_name,
      duration: i.duration,
      progress: i.progress > 0 ? i.progress : undefined,
    }));
}

interface SearchItem {
  bvid: string;
  aid: number;
  title: string;
  pic: string;
  author: string;
  mid: number;
  duration: string; // "mm:ss"
  play: number;
}

function parseDurationStr(s: string): number {
  const parts = s.split(':').map((n) => parseInt(n, 10));
  if (parts.some(Number.isNaN)) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

export async function search(sess: BiliSession, keyword: string, page = 1): Promise<VideoCard[]> {
  await ensureBuvid(sess);
  const { imgKey, subKey } = await getWbiKeys(sess);
  const q = encWbi({ search_type: 'video', keyword, page, page_size: 30 }, imgKey, subKey);
  const json = await apiGet<{ result: SearchItem[] }>(
    `${API}/x/web-interface/wbi/search/type?${q}`,
    sess,
  );
  return (json.data?.result ?? [])
    .filter((i) => i.bvid)
    .map((i) => ({
      bvid: i.bvid,
      aid: i.aid,
      title: i.title.replace(/<[^>]+>/g, ''), // strip <em> highlight tags
      cover: imgProxy(i.pic),
      author: i.author,
      authorMid: i.mid,
      duration: parseDurationStr(i.duration),
      views: i.play,
    }));
}

export async function popular(sess: BiliSession, page = 1): Promise<VideoCard[]> {
  await ensureBuvid(sess);
  const json = await apiGet<{ list: RcmdItem[] }>(
    `${API}/x/web-interface/popular?ps=30&pn=${page}`,
    sess,
  );
  return (json.data?.list ?? [])
    .filter((i) => i.bvid)
    .map((i) => ({
      bvid: i.bvid!,
      aid: i.aid ?? i.id,
      cid: i.cid,
      title: i.title,
      cover: imgProxy(i.pic),
      author: i.owner?.name ?? '',
      authorMid: i.owner?.mid,
      duration: i.duration,
      views: i.stat?.view,
    }));
}

interface DynArchive {
  bvid: string;
  title: string;
  cover: string;
  duration_text?: string;
  stat?: { play: number | string };
}
interface DynItem {
  type: string;
  modules?: {
    module_author?: { name: string; mid: number };
    module_dynamic?: { major?: { archive?: DynArchive } };
  };
}

/** Latest videos posted by the accounts the logged-in user follows (dynamic feed). */
export async function following(sess: BiliSession, page = 1): Promise<VideoCard[]> {
  const json = await apiGet<{ items: DynItem[] }>(
    `${API}/x/polymer/web-dynamic/v1/feed/all?type=video&page=${page}`,
    sess,
  );
  const out: VideoCard[] = [];
  for (const it of json.data?.items ?? []) {
    if (it.type !== 'DYNAMIC_TYPE_AV') continue;
    const a = it.modules?.module_dynamic?.major?.archive;
    if (!a?.bvid) continue;
    const play = a.stat?.play;
    out.push({
      bvid: a.bvid,
      title: a.title,
      cover: imgProxy(a.cover),
      author: it.modules?.module_author?.name ?? '',
      authorMid: it.modules?.module_author?.mid,
      duration: a.duration_text ? parseDurationStr(a.duration_text) : undefined,
      views: typeof play === 'number' ? play : Number(play) || undefined,
    });
  }
  return out;
}

// ---------- video + playback ----------

interface ViewData {
  bvid: string;
  aid: number;
  title: string;
  desc: string;
  pic: string;
  duration: number;
  owner: { name: string; mid: number };
  pages: { cid: number; page: number; part: string; duration: number }[];
}

export async function videoInfo(
  sess: BiliSession,
  bvid: string,
): Promise<{ info: VideoInfo; pages: VideoPage[] }> {
  const json = await apiGet<ViewData>(
    `${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    sess,
  );
  const d = json.data;
  if (!d) throw new Error(`view failed: ${json.code} ${json.message}`);
  return {
    info: {
      bvid: d.bvid,
      aid: d.aid,
      title: d.title,
      desc: d.desc,
      cover: imgProxy(d.pic),
      author: d.owner?.name ?? '',
      authorMid: d.owner?.mid ?? 0,
      duration: d.duration,
    },
    pages: (d.pages ?? []).map((p) => ({
      cid: p.cid,
      page: p.page,
      part: p.part,
      duration: p.duration,
    })),
  };
}

interface DashRep {
  id: number;
  baseUrl: string;
  base_url?: string;
  backupUrl?: string[];
  backup_url?: string[];
  bandwidth: number;
  codecs: string;
  mimeType?: string;
  mime_type?: string;
  width?: number;
  height?: number;
  frameRate?: string;
  frame_rate?: string;
}

interface PlayUrlData {
  quality: number;
  accept_quality: number[];
  accept_description: string[];
  dash?: { duration: number; video: DashRep[]; audio: DashRep[] };
}

function mapRep(r: DashRep): Track {
  const primary = r.baseUrl ?? r.base_url ?? '';
  const backup = (r.backupUrl ?? r.backup_url ?? [])[0];
  return {
    url: streamProxy(primary),
    backupUrl: backup ? streamProxy(backup) : undefined,
    codecs: r.codecs,
    mimeType: r.mimeType ?? r.mime_type ?? '',
    bandwidth: r.bandwidth,
    id: r.id,
    width: r.width,
    height: r.height,
    frameRate: r.frameRate ?? r.frame_rate,
  };
}

export async function playurl(
  sess: BiliSession,
  bvid: string,
  cid: number,
  qn = 80,
): Promise<PlayUrl> {
  const { imgKey, subKey } = await getWbiKeys(sess);
  const q = encWbi({ bvid, cid, qn, fnval: 4048, fnver: 0, fourk: 1 }, imgKey, subKey);
  const json = await apiGet<PlayUrlData>(`${API}/x/player/wbi/playurl?${q}`, sess);
  const d = json.data;
  if (!d?.dash) throw new Error(`playurl failed: ${json.code} ${json.message}`);

  const hostOf = (u?: string) => {
    try {
      return u ? new URL(u).hostname : '?';
    } catch {
      return '?';
    }
  };
  log(
    'info',
    'bili',
    `playurl ${bvid} cid=${cid} qn=${d.quality} videoHosts=[${(d.dash.video ?? [])
      .slice(0, 3)
      .map((v) => hostOf(v.baseUrl ?? v.base_url))
      .join(',')}] audioHost=${hostOf(d.dash.audio?.[0]?.baseUrl ?? d.dash.audio?.[0]?.base_url)}`,
  );

  const qualities = (d.accept_quality ?? []).map((id, idx) => ({
    id,
    label: d.accept_description?.[idx] ?? String(id),
  }));

  return {
    videos: (d.dash.video ?? []).map(mapRep),
    audios: (d.dash.audio ?? []).map(mapRep),
    qualities,
    currentQn: d.quality,
    durationSec: d.dash.duration,
  };
}

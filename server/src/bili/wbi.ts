import { createHash } from 'node:crypto';

// Fixed permutation used by Bilibili to derive the WBI "mixin key" from
// (img_key + sub_key). This table is stable across the site.
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

export function getMixinKey(imgKey: string, subKey: string): string {
  const orig = imgKey + subKey;
  let mixed = '';
  for (const idx of MIXIN_KEY_ENC_TAB) mixed += orig[idx] ?? '';
  return mixed.slice(0, 32);
}

/** Extract the key (filename without extension) from a wbi_img url. */
export function keyFromUrl(url: string): string {
  return url.split('/').pop()?.split('.')[0] ?? '';
}

/**
 * WBI-sign a parameter map. Returns a ready-to-use query string including
 * `wts` and `w_rid`.
 */
export function encWbi(
  params: Record<string, string | number | boolean>,
  imgKey: string,
  subKey: string,
): string {
  const mixinKey = getMixinKey(imgKey, subKey);
  const wts = Math.floor(Date.now() / 1000);
  const query: Record<string, string | number | boolean> = { ...params, wts };

  const parts: string[] = [];
  for (const k of Object.keys(query).sort()) {
    // Bilibili strips these characters from values before signing.
    const v = String(query[k]).replace(/[!'()*]/g, '');
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  const q = parts.join('&');
  const wRid = createHash('md5').update(q + mixinKey).digest('hex');
  return `${q}&w_rid=${wRid}`;
}

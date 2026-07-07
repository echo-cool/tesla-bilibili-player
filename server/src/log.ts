type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const configured = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
const threshold = ORDER[configured] ?? ORDER.info;

/**
 * Structured-ish stdout logger (docker logs friendly):
 *   2026-07-04T21:00:00.000Z INFO  [proxy] upos-hz-mirrorakam.akamaized.net 206 range=bytes=0-1048575 sent=1048576B 812ms
 * Set LOG_LEVEL=debug for chatty detail.
 */
export function log(level: Level, tag: string, msg: string, extra?: unknown): void {
  if (ORDER[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  const payload = extra === undefined ? line : `${line} ${safeJson(extra)}`;
  if (level === 'error') console.error(payload);
  else if (level === 'warn') console.warn(payload);
  else console.log(payload);
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

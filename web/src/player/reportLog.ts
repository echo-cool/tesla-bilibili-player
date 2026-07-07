// Batches player events and ships them to the backend (/api/log) so problems on
// devices without devtools (the Tesla browser) are visible in server logs.

interface ClientEvent {
  level: 'info' | 'warn' | 'error';
  tag: string;
  msg: string;
}

const queue: ClientEvent[] = [];
let timer: number | undefined;

function flush() {
  timer = undefined;
  if (queue.length === 0) return;
  const events = queue.splice(0, 50);
  void fetch('/api/log', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
    keepalive: true,
  }).catch(() => {
    /* logging must never break playback */
  });
}

export function report(level: ClientEvent['level'], tag: string, msg: string): void {
  // Mirror locally for desktop debugging.
  const line = `[${tag}] ${msg}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);

  queue.push({ level, tag, msg });
  if (level === 'error') {
    if (timer) clearTimeout(timer);
    flush(); // errors go out immediately
    return;
  }
  if (!timer) timer = window.setTimeout(flush, 5000);
}

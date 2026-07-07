import {
  createFile,
  DataStream,
  type MP4ArrayBuffer,
  type MP4File,
  type MP4Info,
  type MP4Sample,
} from 'mp4box';

export type TrackKind = 'video' | 'audio';

export interface VideoConfig {
  kind: 'video';
  codec: string;
  codedWidth: number;
  codedHeight: number;
  description?: Uint8Array;
}
export interface AudioConfig {
  kind: 'audio';
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
}
export type StreamConfig = VideoConfig | AudioConfig;

export interface EncodedSample {
  key: boolean;
  timestamp: number; // microseconds
  duration: number; // microseconds
  data: Uint8Array;
}

interface DemuxerOptions {
  url: string;
  /** Bilibili's backup CDN URL — used automatically if the primary fails/hangs. */
  backupUrl?: string;
  kind: TrackKind;
  onConfig: (config: StreamConfig) => void;
  onSample: (sample: EncodedSample) => void;
  onDone: () => void;
  onError: (e: unknown) => void;
  /** Diagnostics hook (failovers, retries). */
  onEvent?: (msg: string) => void;
  /** Upstream returned 403/410 — the signed URL expired; caller should refresh. */
  onExpired?: () => void;
}

const CHUNK = 1 << 20; // 1 MiB range requests
const FETCH_TIMEOUT_MS = 20_000; // a hung chunk must fail, not buffer forever
const MAX_RETRIES = 3; // per-chunk retries after the backup CDN is exhausted
const RETRY_DELAY_MS = 500;

/**
 * Streams one Bilibili DASH representation (a single fragmented-MP4 file with an
 * sidx index, served with Range support through our proxy), demuxes it with
 * mp4box.js, and emits the decoder config plus encoded samples.
 *
 * Fetching honours pause()/resume() for backpressure, and seekTo() repositions
 * the download using the sidx index parsed by mp4box — all on one live instance
 * so the moov/config are parsed only once.
 */
export class Demuxer {
  private mp4: MP4File;
  private trackId = -1;
  private offset = 0;
  private total = Infinity;
  private url: string;
  private usedBackup = false;
  private retries = 0;
  private paused = false;
  private aborted = false;
  private eofSignaled = false;
  private gen = 0;
  private resumeResolve: (() => void) | null = null;
  private parkedResolve: (() => void) | null = null;
  private readonly opts: DemuxerOptions;

  constructor(opts: DemuxerOptions) {
    this.opts = opts;
    this.url = opts.url;
    this.mp4 = createFile();
    this.mp4.onError = (e) => this.opts.onError(e);
    this.mp4.onReady = (info) => this.onReady(info);
    this.mp4.onSamples = (_id, _user, samples) => this.onSamples(samples);
  }

  private onReady(info: MP4Info) {
    const track = this.opts.kind === 'video' ? info.videoTracks[0] : info.audioTracks[0];
    if (!track) {
      this.opts.onError(new Error(`no ${this.opts.kind} track in stream`));
      return;
    }
    this.trackId = track.id;

    if (this.opts.kind === 'video') {
      const v = info.videoTracks[0];
      this.opts.onConfig({
        kind: 'video',
        codec: v.codec,
        codedWidth: v.video.width,
        codedHeight: v.video.height,
        description: this.videoDescription(v.id),
      });
    } else {
      const a = info.audioTracks[0];
      this.opts.onConfig({
        kind: 'audio',
        codec: a.codec,
        sampleRate: a.audio.sample_rate,
        numberOfChannels: a.audio.channel_count,
        description: this.audioDescription(a.id),
      });
    }

    this.mp4.setExtractionOptions(this.trackId, null, { nbSamples: 100 });
    this.mp4.start();
  }

  private onSamples(samples: MP4Sample[]) {
    for (const s of samples) {
      this.opts.onSample({
        key: s.is_sync,
        timestamp: (s.cts / s.timescale) * 1e6,
        duration: (s.duration / s.timescale) * 1e6,
        data: s.data,
      });
    }
    const last = samples[samples.length - 1];
    if (last) this.mp4.releaseUsedSamples(this.trackId, last.number);
  }

  private videoDescription(trackId: number): Uint8Array | undefined {
    const trak = this.mp4.getTrackById(trackId);
    for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
      const box = entry.avcC || entry.hvcC || entry.av1C || entry.vpcC;
      if (box) {
        const ds = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(ds);
        return new Uint8Array(ds.buffer, 8); // strip 8-byte box header
      }
    }
    return undefined;
  }

  private audioDescription(trackId: number): Uint8Array | undefined {
    const trak = this.mp4.getTrackById(trackId);
    for (const entry of trak?.mdia?.minf?.stbl?.stsd?.entries ?? []) {
      const esds = entry.esds;
      if (!esds) continue;
      const findData = (node: unknown): Uint8Array | undefined => {
        const n = node as { data?: Uint8Array; descs?: unknown[] };
        if (n?.data) return n.data;
        for (const child of n?.descs ?? []) {
          const found = findData(child);
          if (found) return found;
        }
        return undefined;
      };
      const asc = findData(esds.esd);
      if (asc) return asc;
    }
    return undefined;
  }

  async start(startByte = 0): Promise<void> {
    this.offset = startByte;
    this.aborted = false;
    this.gen++;
    const g = this.gen;
    try {
      while (!this.aborted && g === this.gen) {
        await this.waitWhilePaused();
        if (this.aborted || g !== this.gen) break;

        if (this.offset >= this.total) {
          if (!this.eofSignaled) {
            this.eofSignaled = true;
            this.opts.onDone();
          }
          this.paused = true; // park until a seek repositions us
          continue;
        }

        let res: Response;
        try {
          res = await this.fetchChunk(this.offset);
        } catch (err) {
          if (this.aborted || g !== this.gen) break;
          if (await this.recover(`fetch failed (${String(err).slice(0, 80)})`)) continue;
          throw err;
        }
        if (g !== this.gen) break;
        if (res.status === 416) {
          this.total = this.offset;
          continue;
        }
        if (res.status === 403 || res.status === 410) {
          // Signed URL expired — backup shares the same deadline, so don't fail
          // over; ask the player to refetch playurl and reload.
          this.opts.onExpired?.();
          return;
        }
        if (!res.ok && res.status !== 206 && res.status !== 200) {
          if (await this.recover(`upstream ${res.status}`)) continue;
          throw new Error(`stream fetch ${res.status}`);
        }
        const cr = res.headers.get('content-range');
        if (cr) {
          const t = Number(cr.split('/')[1]);
          if (Number.isFinite(t)) this.total = t;
        }
        // Reading the body can fail even after a 2xx (CDN terminates mid-chunk;
        // the proxy then surfaces a content-length mismatch). That must go through
        // the same failover/retry path as a failed fetch, not kill playback.
        let u8: Uint8Array;
        try {
          u8 = new Uint8Array(await res.arrayBuffer());
        } catch (err) {
          if (this.aborted || g !== this.gen) break;
          if (await this.recover(`body read failed (${String(err).slice(0, 80)})`)) continue;
          throw err;
        }
        if (g !== this.gen) break;
        this.retries = 0; // a complete chunk clears the transient-failure budget
        if (u8.byteLength === 0) {
          this.total = this.offset;
          continue;
        }
        const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as MP4ArrayBuffer;
        ab.fileStart = this.offset;
        this.mp4.appendBuffer(ab);
        this.offset += u8.byteLength;
      }
    } catch (e) {
      if (!this.aborted && g === this.gen) this.opts.onError(e);
    }
  }

  /** One ranged chunk fetch with a hard timeout so a hung CDN can't stall us silently. */
  private async fetchChunk(offset: number): Promise<Response> {
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(new Error('chunk timeout')), FETCH_TIMEOUT_MS);
    try {
      return await fetch(this.url, {
        headers: { Range: `bytes=${offset}-${offset + CHUNK - 1}` },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Try to recover from a failed chunk: fail over to the backup CDN once, then
   * allow a few delayed retries on the current URL. Returns false when out of
   * options (the caller should surface the error).
   */
  private async recover(reason: string): Promise<boolean> {
    if (!this.usedBackup && this.opts.backupUrl) {
      this.usedBackup = true;
      this.url = this.opts.backupUrl;
      this.opts.onEvent?.(`${this.opts.kind}: switching to backup CDN after ${reason}`);
      return true;
    }
    if (this.retries < MAX_RETRIES) {
      this.retries++;
      this.opts.onEvent?.(`${this.opts.kind}: retry ${this.retries}/${MAX_RETRIES} after ${reason}`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS * this.retries));
      return true;
    }
    return false;
  }

  private waitWhilePaused(): Promise<void> | void {
    if (!this.paused) return;
    return new Promise<void>((resolve) => {
      this.resumeResolve = resolve;
      if (this.parkedResolve) {
        this.parkedResolve();
        this.parkedResolve = null;
      }
    });
  }

  /** Pause fetching (used for backpressure; does not wait for idle). */
  pause(): void {
    this.paused = true;
  }

  /** Pause and resolve once the fetch loop is idle (no in-flight request). */
  pauseAndIdle(): Promise<void> {
    this.paused = true;
    return new Promise<void>((resolve) => {
      if (this.resumeResolve) resolve();
      else this.parkedResolve = resolve;
    });
  }

  /** Reposition the download to a timestamp using mp4box's sidx index. */
  seekTo(seconds: number): void {
    try {
      const { offset } = this.mp4.seek(seconds, true);
      this.offset = offset;
    } catch {
      this.offset = 0;
    }
    this.eofSignaled = false;
  }

  resume(): void {
    this.paused = false;
    if (this.resumeResolve) {
      this.resumeResolve();
      this.resumeResolve = null;
    }
  }

  destroy(): void {
    this.aborted = true;
    this.gen++;
    this.resume();
    try {
      this.mp4.stop();
    } catch {
      /* ignore */
    }
  }
}

import { Demuxer, type AudioConfig, type EncodedSample, type VideoConfig } from './demuxer';
import { report } from './reportLog';

export type PlayerState = 'idle' | 'buffering' | 'playing' | 'paused' | 'ended' | 'error';

export interface PlayerCallbacks {
  onTime?: (currentSec: number) => void;
  onDurationChange?: (durationSec: number) => void;
  onStateChange?: (state: PlayerState) => void;
  onError?: (message: string) => void;
  /** Stream URLs returned 403/expired — caller should refetch playurl and reload. */
  onExpired?: () => void;
}

// How often to report playback time to the UI. The render loop runs at ~60fps but
// the progress bar only needs a few updates/sec — reporting every frame forces a
// React re-render 60x/sec, wasting CPU that the decoder needs (esp. on the Tesla).
const TIME_REPORT_INTERVAL_MS = 250;

export interface LoadOptions {
  videoUrl: string;
  videoBackupUrl?: string;
  audioUrl: string;
  audioBackupUrl?: string;
  durationSec: number;
}

// Read-ahead window (seconds of demuxed-but-undecoded data to keep buffered).
const BUFFER_HIGH = 30;
const BUFFER_LOW = 15;
// Bound the number of simultaneously-live VideoFrames = queued-for-display PLUS
// in-flight in the decoder. Hardware decoders have a small output-surface pool
// (~8-12 on embedded GPUs); hold too many and the decoder stalls. We cap how far
// AHEAD we decode instead of dropping already-decoded frames (dropping = low FPS).
// ~5 gives a smooth presentation buffer while staying well under the pool.
const MAX_OUTSTANDING_FRAMES = 5;
// If the decoder emits nothing for this long while we have data, treat it as
// wedged and recover by reinitializing at the current position.
const VIDEO_STALL_MS = 4000;
const MAX_STALL_RECOVERIES = 3;
// Keep a deep, sample-continuous queue on the audio render thread. mp4box,
// canvas painting, GC, and rAF throttling can block Tesla's relatively slow
// browser main thread for seconds at a time. Short AudioBufferSourceNode chains
// turn those stalls into the repeated syllables/static users hear as tearing.
const AUDIO_AHEAD_LOW = 4;
const AUDIO_AHEAD_HIGH = 6;
const AUDIO_DECODE_AHEAD = 8;
const AUDIO_START_DELAY = 0.12;
const AUDIO_PRIME_BUFFER = 0.35;
const AUDIO_RESUME_BUFFER = 0.7;
const AUDIO_UNDERRUN_GUARD = 0.12;
// Container timestamps are only used to break the sample-accurate chain when
// there is a genuine timeline discontinuity.
const AUDIO_DISCONTINUITY_SEC = 0.25;
const AUDIO_BATCH_GAP_TOLERANCE_SEC = 0.002;
// rAF can be throttled independently of audio in the in-car browser. This timer
// keeps decoding/scheduling alive when that happens.
const AUDIO_TICK_MS = 250;

/**
 * Anti-freeze video player: demuxes Bilibili DASH, decodes with WebCodecs, paints
 * frames to a <canvas>, and plays audio through Web Audio. Because there is no
 * <video> element, the Tesla browser's in-motion media lock never engages.
 *
 * Audio is NOT sent to audioCtx.destination: the Tesla browser only routes sound
 * to the car speakers (and switches the audio channel from music to browser) when
 * an HTML media element is playing. So the graph terminates in a
 * MediaStreamAudioDestinationNode whose stream feeds a hidden <audio> element —
 * audio-only, so the in-motion video lock still never engages.
 *
 * The audio graph's clock (AudioContext.currentTime) is the master; video frames
 * are presented when their timestamp reaches the clock.
 */
export class CanvasPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: PlayerCallbacks;

  private audioCtx: AudioContext;
  private gain: GainNode;
  private mediaDest: MediaStreamAudioDestinationNode;
  private audioEl: HTMLAudioElement;

  private videoDecoder: VideoDecoder | null = null;
  private audioDecoder: AudioDecoder | null = null;
  private videoConfig: VideoConfig | null = null;
  private audioConfig: AudioConfig | null = null;
  private videoDemuxer: Demuxer | null = null;
  private audioDemuxer: Demuxer | null = null;

  private encodedVideo: EncodedSample[] = [];
  private encodedAudio: EncodedSample[] = [];
  private vIdx = 0;
  private aIdx = 0;
  private videoDone = false;
  private audioDone = false;

  private frameQueue: VideoFrame[] = [];
  private decodedAudio: AudioData[] = [];
  private activeSources = new Set<AudioBufferSourceNode>();

  private state: PlayerState = 'idle';
  private durationSec = 0;
  private baseMediaTime = 0; // media time at ctxStartTime
  private ctxStartTime: number | null = null; // audioCtx.currentTime when playback began
  private lastAudioScheduledSec = 0;
  private nextAudioStartTime = 0; // context time where the next audio chunk must start (sample-accurate chain)
  private volume = 1;
  private wantPlaying = true; // desired play/pause independent of buffering
  private seeking = false; // guards the demuxers during a seek's critical section
  private needVideoKey = true; // after (re)configure, decode must start on a keyframe
  private lastVideoOutputAt = 0; // performance.now() of the last decoder output
  private stallRecoveries = 0;
  private lastTimeReportMs = 0;
  private expiredSignaled = false;
  private suppressAudioElementPause = false;
  private suppressAudioContextState = false;
  private audioContextTransitionToken = 0;
  private destroyed = false;
  private raf = 0;
  private audioTimer = 0;
  private canvasSized = false;

  // Stats (for the debug overlay).
  private renderedFrames = 0;
  private decodedFrames = 0;
  private droppedFrames = 0;
  private statsMark = { t: 0, rendered: 0, decoded: 0 };

  private onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') this.pauseForInterruption('document hidden');
  };
  private onPageHide = () => this.pauseForInterruption('pagehide');
  private onPageFreeze = () => this.pauseForInterruption('page freeze');
  private onWindowBlur = () => this.pauseForInterruption('window blur');
  private onAudioElementPause = () => {
    if (this.suppressAudioElementPause || this.destroyed || !this.wantPlaying) return;
    if (this.state === 'playing' || this.state === 'buffering') {
      this.pauseForInterruption('audio sink paused externally');
    }
  };
  private onAudioContextStateChange = () => {
    if (this.suppressAudioContextState || this.destroyed || !this.wantPlaying) return;
    if (this.audioCtx.state === 'suspended' && this.state === 'playing') {
      this.pauseForInterruption('audio context suspended externally');
    }
  };

  constructor(canvas: HTMLCanvasElement, cb: PlayerCallbacks = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2d canvas context unavailable');
    this.ctx = ctx;
    this.cb = cb;
    this.audioCtx = createAudioContext();
    this.audioCtx.onstatechange = this.onAudioContextStateChange;
    this.gain = this.audioCtx.createGain();
    this.mediaDest = this.audioCtx.createMediaStreamDestination();
    this.gain.connect(this.mediaDest);
    this.audioEl = document.createElement('audio');
    this.audioEl.srcObject = this.mediaDest.stream;
    this.audioEl.style.display = 'none';
    this.audioEl.addEventListener('pause', this.onAudioElementPause);
    document.body.appendChild(this.audioEl);
    this.installInterruptionHandlers();
  }

  static isSupported(): boolean {
    return typeof VideoDecoder === 'function' && typeof AudioDecoder === 'function';
  }

  async load(opts: LoadOptions): Promise<void> {
    this.teardownPipeline();
    this.durationSec = opts.durationSec;
    this.cb.onDurationChange?.(this.durationSec);
    this.baseMediaTime = 0;
    this.ctxStartTime = null;
    this.lastAudioScheduledSec = 0;
    this.nextAudioStartTime = 0;
    this.stallRecoveries = 0;
    this.expiredSignaled = false;
    this.lastTimeReportMs = 0;
    this.lastVideoOutputAt = performance.now();
    this.renderedFrames = 0;
    this.decodedFrames = 0;
    this.droppedFrames = 0;
    this.statsMark = { t: performance.now(), rendered: 0, decoded: 0 };
    this.setState('buffering');
    report('info', 'player', `load duration=${opts.durationSec}s`);

    this.setupDecoders();

    this.videoDemuxer = new Demuxer({
      url: opts.videoUrl,
      backupUrl: opts.videoBackupUrl,
      kind: 'video',
      onConfig: (c) => this.configureVideo(c as VideoConfig),
      onSample: (s) => this.encodedVideo.push(s),
      onDone: () => (this.videoDone = true),
      onError: (e) => this.fail('video: ' + errMsg(e)),
      onEvent: (m) => report('warn', 'demux', m),
      onExpired: () => this.handleExpired(),
    });
    this.audioDemuxer = new Demuxer({
      url: opts.audioUrl,
      backupUrl: opts.audioBackupUrl,
      kind: 'audio',
      onConfig: (c) => this.configureAudio(c as AudioConfig),
      onSample: (s) => this.encodedAudio.push(s),
      onDone: () => (this.audioDone = true),
      onError: (e) => this.fail('audio: ' + errMsg(e)),
      onEvent: (m) => report('warn', 'demux', m),
      onExpired: () => this.handleExpired(),
    });

    void this.videoDemuxer.start(0);
    void this.audioDemuxer.start(0);
    this.audioTimer = window.setInterval(() => this.tick(), AUDIO_TICK_MS);
    this.loop();
  }

  // ---------- decoder setup ----------

  private setupDecoders() {
    this.needVideoKey = true;
    this.videoDecoder = new VideoDecoder({
      output: (frame) => this.onVideoFrame(frame),
      error: (e) => this.fail('video decoder: ' + e.message),
    });
    this.audioDecoder = new AudioDecoder({
      output: (data) => this.decodedAudio.push(data),
      error: (e) => this.fail('audio decoder: ' + e.message),
    });
  }

  private configureVideo(c: VideoConfig) {
    this.videoConfig = c;
    report('info', 'player', `video config codec=${c.codec} ${c.codedWidth}x${c.codedHeight}`);
    this.videoDecoder?.configure({
      codec: c.codec,
      codedWidth: c.codedWidth,
      codedHeight: c.codedHeight,
      description: c.description,
      optimizeForLatency: false,
    });
  }

  private configureAudio(c: AudioConfig) {
    this.audioConfig = c;
    this.audioDecoder?.configure({
      codec: c.codec,
      sampleRate: c.sampleRate,
      numberOfChannels: c.numberOfChannels,
      description: c.description,
    });
  }

  /**
   * Recreate the audio graph with the context running at the media's sample rate.
   * When an AudioBuffer's rate differs from the context rate, every
   * AudioBufferSourceNode resamples on its own, and the interpolator state resets
   * at each ~23ms chunk boundary — audible as constant crackle, worse at high
   * volume. With the rates matched, consecutive chunks are bit-exact
   * continuations; the sink <audio> element resamples the final mix continuously.
   */
  private matchAudioContextRate(rate: number) {
    const oldRate = this.audioCtx.sampleRate;
    let ctx: AudioContext;
    try {
      ctx = createAudioContext(rate);
      if (Math.abs(ctx.sampleRate - rate) > 1) {
        void ctx.close().catch(() => {});
        report('warn', 'player', `context rate ${rate}Hz unsupported — keeping ${oldRate}Hz`);
        return;
      }
    } catch {
      report('warn', 'player', `context rate ${rate}Hz unsupported — keeping ${oldRate}Hz`);
      return;
    }
    this.stopAllAudio();
    if (this.ctxStartTime !== null) {
      // Rebuild mid-playback (shouldn't happen in practice): keep the position.
      this.baseMediaTime = this.getMediaTime();
      this.ctxStartTime = null;
    }
    this.audioCtx.onstatechange = null;
    void this.audioCtx.close().catch(() => {});
    this.audioCtx = ctx;
    this.audioCtx.onstatechange = this.onAudioContextStateChange;
    this.gain = ctx.createGain();
    this.gain.gain.value = this.volume;
    this.mediaDest = ctx.createMediaStreamDestination();
    this.gain.connect(this.mediaDest);
    this.audioEl.srcObject = this.mediaDest.stream;
    this.nextAudioStartTime = 0;
    report('info', 'player', `audio graph rebuilt at ${rate}Hz (device default was ${oldRate}Hz)`);
    if (this.wantPlaying) {
      void this.resumeAudioContext().catch(() => {});
      void this.audioEl.play().catch(() => {});
    }
  }

  private onVideoFrame(frame: VideoFrame) {
    this.lastVideoOutputAt = performance.now();
    this.decodedFrames++;
    if (!this.canvasSized) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
      this.canvasSized = true;
    }
    // Do NOT drop frames here — pumpVideo bounds how far ahead we decode, so the
    // queue stays small on its own. Dropping decoded frames would lower the FPS.
    this.frameQueue.push(frame);
  }

  // ---------- main loop ----------

  private loop = () => {
    this.tick();
    this.raf = requestAnimationFrame(this.loop);
  };

  private tick() {
    // One bad tick must never kill the render loop (which also drives backpressure).
    try {
      this.pumpVideo();
      this.pumpAudio();

      if (this.ctxStartTime === null) {
        this.maybePrime();
        this.drawFirstFrame();
      } else {
        this.scheduleAudio();
        const clock = this.getMediaTime();
        this.manageAudioContinuity(clock);
        this.presentVideo(clock);
        this.reportTime(clock);
        this.checkEnded(clock);
        this.watchdog();
      }

      this.manageBackpressure();
    } catch (e) {
      report('error', 'player', 'tick error: ' + errMsg(e));
    }
  }

  /**
   * Detects a wedged video decoder (playing, data available, but no frame output
   * for VIDEO_STALL_MS — the "video freezes, audio continues" failure) and
   * recovers by reinitializing the decode pipeline at the current position.
   */
  private watchdog() {
    if (this.state !== 'playing' || this.seeking) return;
    const pendingInput =
      this.vIdx < this.encodedVideo.length || (this.videoDecoder?.decodeQueueSize ?? 0) > 0 || !this.videoDone;
    if (!pendingInput || this.frameQueue.length > 0) return;
    const stalledMs = performance.now() - this.lastVideoOutputAt;
    if (stalledMs < VIDEO_STALL_MS) return;

    this.stallRecoveries++;
    this.lastVideoOutputAt = performance.now(); // don't re-trigger while recovering
    if (this.stallRecoveries > MAX_STALL_RECOVERIES) {
      report('error', 'player', `video decoder stalled ${MAX_STALL_RECOVERIES + 1}x, giving up`);
      this.fail('video decoder stalled repeatedly');
      return;
    }
    const at = this.getMediaTime();
    report(
      'warn',
      'player',
      `video stalled ${Math.round(stalledMs)}ms at t=${at.toFixed(1)} (recovery ${this.stallRecoveries}/${MAX_STALL_RECOVERIES}) — reinitializing`,
    );
    void this.seek(at);
  }

  private pumpVideo() {
    const dec = this.videoDecoder;
    if (!dec || dec.state !== 'configured') return;
    // Bound live frames = already-decoded (queued) + still-in-decoder. This caps
    // decode-ahead without discarding output, so FPS is preserved and the
    // decoder's surface pool isn't exhausted.
    while (
      this.vIdx < this.encodedVideo.length &&
      this.frameQueue.length + dec.decodeQueueSize < MAX_OUTSTANDING_FRAMES
    ) {
      const s = this.encodedVideo[this.vIdx++];
      // After a (re)configure the first chunk must be a keyframe, else the
      // decoder throws. Drop leading delta samples until the next keyframe.
      if (this.needVideoKey) {
        if (!s.key) continue;
        this.needVideoKey = false;
      }
      try {
        dec.decode(
          new EncodedVideoChunk({
            type: s.key ? 'key' : 'delta',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          }),
        );
      } catch (e) {
        report('warn', 'player', 'video decode error: ' + errMsg(e));
        this.needVideoKey = true; // resync on the next keyframe
      }
    }
  }

  private pumpAudio() {
    const dec = this.audioDecoder;
    if (!dec || dec.state !== 'configured') return;
    const clock = this.getMediaTime();
    // One timer tick must be able to submit well over a second of AAC. A cap of
    // 16 chunks is only ~0.35s and cannot keep up when Tesla throttles rAF.
    while (
      this.aIdx < this.encodedAudio.length &&
      dec.decodeQueueSize < 64 &&
      this.audioReadyAheadSec(clock) < AUDIO_DECODE_AHEAD
    ) {
      const s = this.encodedAudio[this.aIdx++];
      try {
        dec.decode(
          new EncodedAudioChunk({
            type: 'key',
            timestamp: s.timestamp,
            duration: s.duration,
            data: s.data,
          }),
        );
      } catch (e) {
        report('warn', 'player', 'audio decode error: ' + errMsg(e));
      }
    }
  }

  private audioReadyAheadSec(clock: number): number {
    return Math.max(0, Math.max(this.lastAudioScheduledSec, this.decodedAudioEndSec()) - clock);
  }

  private decodedAudioEndSec(): number {
    const last = this.decodedAudio[this.decodedAudio.length - 1];
    if (!last) return 0;
    return last.timestamp / 1e6 + last.numberOfFrames / last.sampleRate;
  }

  /** Start the clock once we have a first frame and (if present) some audio decoded. */
  private maybePrime() {
    const haveVideo = this.frameQueue.length > 0;
    const haveAudio = this.audioDone || this.audioReadyAheadSec(this.baseMediaTime) >= AUDIO_PRIME_BUFFER;
    if (!haveVideo || !haveAudio) return;

    // HE-AAC can advertise its core rate in the MP4 config while AudioDecoder
    // outputs at twice that rate. Trust the decoded PCM here. Matching it avoids
    // restarting a resampler at every source-node boundary (constant crackle).
    const first = this.decodedAudio[0];
    if (first && first.sampleRate !== this.audioCtx.sampleRate) {
      this.matchAudioContextRate(first.sampleRate);
    }

    this.ctxStartTime = this.audioCtx.currentTime + AUDIO_START_DELAY;
    if (this.wantPlaying) {
      this.resumeAudio();
    } else {
      this.pauseAudioOutput({ pauseSink: true });
      this.setState('paused');
    }
  }

  /**
   * Resume the audio clock. Sound is audible only when BOTH the AudioContext is
   * running AND the sink <audio> element is playing — if autoplay blocks either,
   * we surface 'paused' and let the UI show a tap-to-play affordance instead
   * of pretending to play on a frozen first frame.
   */
  private resumeAudio() {
    this.resumeFetchers();
    Promise.all([this.resumeAudioContext(), this.audioEl.play()])
      .then(() => {
        if (this.audioCtx.state === 'running' && !this.audioEl.paused) {
          if (this.state !== 'ended') this.setState('playing');
        } else {
          this.setState('paused');
        }
      })
      .catch(() => this.setState('paused'));
  }

  private resumeAudioContext(): Promise<void> {
    const token = ++this.audioContextTransitionToken;
    this.suppressAudioContextState = true;
    return this.audioCtx.resume().finally(() => {
      if (token === this.audioContextTransitionToken) this.suppressAudioContextState = false;
    });
  }

  private pauseAudioOutput({ pauseSink }: { pauseSink: boolean }) {
    const token = ++this.audioContextTransitionToken;
    this.suppressAudioContextState = true;
    void this.audioCtx
      .suspend()
      .catch(() => {})
      .finally(() => {
        if (token === this.audioContextTransitionToken) this.suppressAudioContextState = false;
      });

    if (pauseSink && !this.audioEl.paused) {
      this.suppressAudioElementPause = true;
      this.audioEl.pause();
      window.setTimeout(() => {
        this.suppressAudioElementPause = false;
      }, 0);
    }
  }

  private pauseFetchers() {
    this.videoDemuxer?.pause();
    this.audioDemuxer?.pause();
  }

  private resumeFetchers() {
    this.videoDemuxer?.resume();
    this.audioDemuxer?.resume();
  }

  private drawFirstFrame() {
    const f = this.frameQueue[0];
    if (f) this.ctx.drawImage(f, 0, 0, this.canvas.width, this.canvas.height);
  }

  private getMediaTime(): number {
    if (this.ctxStartTime === null) return this.baseMediaTime;
    return this.baseMediaTime + (this.audioCtx.currentTime - this.ctxStartTime);
  }

  private scheduleAudio() {
    if (this.ctxStartTime === null) return;
    const now = this.audioCtx.currentTime;
    // Refill in large batches only after the scheduled chain falls below the
    // low-water mark. This greatly reduces source-node creation and GC churn.
    if (this.nextAudioStartTime !== 0 && this.nextAudioStartTime - now > AUDIO_AHEAD_LOW) return;

    while (this.decodedAudio.length) {
      const head = this.decodedAudio[0];
      const rate = head.sampleRate;
      const channels = head.numberOfChannels;
      const headTs = head.timestamp / 1e6;
      const headDuration = head.numberOfFrames / rate;

      // A seek starts demuxing at an earlier random-access point. Discard PCM
      // before the requested position and trim the chunk that straddles it.
      let startOffsetSec = 0;
      if (this.nextAudioStartTime === 0) {
        if (headTs + headDuration <= this.baseMediaTime) {
          this.decodedAudio.shift();
          head.close();
          continue;
        }
        startOffsetSec = Math.min(Math.max(0, this.baseMediaTime - headTs), headDuration);
      }

      const audibleTs = headTs + startOffsetSec;
      const idealWhen = this.ctxStartTime + (audibleTs - this.baseMediaTime);
      // Chain chunks sample-accurately: each starts exactly where the previous
      // one ends. Scheduling every AAC packet by its rounded timestamp creates
      // a tiny seam at every packet boundary.
      let when: number;
      if (this.nextAudioStartTime === 0) {
        when = Math.max(idealWhen, now + 0.02);
      } else {
        when = this.nextAudioStartTime;
        if (when < now) {
          // The main thread stalled beyond all scheduled audio. Re-anchor both
          // audio and the video clock; simply clamping every source to `now`
          // would overlap them and produce the characteristic garbled buzz.
          const target = now + 0.05;
          this.ctxStartTime += target - idealWhen;
          when = target;
          report('warn', 'player', `audio underrun — clock rebased ${(target - idealWhen).toFixed(3)}s`);
        } else if (Math.abs(idealWhen - when) > AUDIO_DISCONTINUITY_SEC) {
          when = Math.max(idealWhen, this.nextAudioStartTime);
        }
      }

      if (when > now + AUDIO_AHEAD_HIGH) break;

      // Coalesce all currently decoded, contiguous PCM into one AudioBuffer.
      // On Tesla this is usually 1–2 seconds rather than one node per AAC frame.
      const batch: AudioData[] = [this.decodedAudio.shift()!];
      let frames = head.numberOfFrames;
      let endTs = headTs + headDuration;
      while (this.decodedAudio.length) {
        const next = this.decodedAudio[0];
        if (next.sampleRate !== rate || next.numberOfChannels !== channels) break;
        if (Math.abs(next.timestamp / 1e6 - endTs) > AUDIO_BATCH_GAP_TOLERANCE_SEC) break;
        if (when + frames / rate >= now + AUDIO_AHEAD_HIGH) break;
        this.decodedAudio.shift();
        batch.push(next);
        frames += next.numberOfFrames;
        endTs = next.timestamp / 1e6 + next.numberOfFrames / rate;
      }

      let buffer: AudioBuffer;
      try {
        buffer = this.audioCtx.createBuffer(channels, frames, rate);
        const channelData = Array.from({ length: channels }, () => new Float32Array(frames));
        let offset = 0;
        for (const data of batch) {
          for (let ch = 0; ch < channels; ch++) {
            const dest = channelData[ch].subarray(offset, offset + data.numberOfFrames);
            // Conversion to f32-planar is the WebCodecs-mandated Web Audio path,
            // including when the decoder's native output is interleaved.
            data.copyTo(dest, { planeIndex: ch, format: 'f32-planar' });
          }
          offset += data.numberOfFrames;
        }
        for (let ch = 0; ch < channels; ch++) buffer.copyToChannel(channelData[ch], ch);
      } finally {
        for (const data of batch) data.close();
      }

      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.gain);
      src.start(when, startOffsetSec);
      this.activeSources.add(src);
      src.onended = () => this.activeSources.delete(src);
      this.nextAudioStartTime = when + (frames / rate - startOffsetSec);
      this.lastAudioScheduledSec = endTs;
    }
  }

  private manageAudioContinuity(clock: number) {
    if (!this.wantPlaying || this.ctxStartTime === null || this.state === 'ended' || this.state === 'error') return;

    const readyAhead = this.audioReadyAheadSec(clock);
    if (this.state === 'playing' && readyAhead < AUDIO_UNDERRUN_GUARD && !this.audioDone) {
      report('warn', 'player', `audio underrun guard at t=${clock.toFixed(2)} ready=${readyAhead.toFixed(2)}s`);
      this.pauseAudioOutput({ pauseSink: false });
      this.setState('buffering');
      return;
    }

    if (this.state === 'buffering' && readyAhead >= AUDIO_RESUME_BUFFER) {
      this.resumeAudio();
    }
  }

  private presentVideo(clock: number) {
    let toDraw: VideoFrame | null = null;
    while (this.frameQueue.length && this.frameQueue[0].timestamp / 1e6 <= clock) {
      if (toDraw) {
        toDraw.close(); // fell behind: this frame's time already passed
        this.droppedFrames++;
      }
      toDraw = this.frameQueue.shift()!;
    }
    if (toDraw) {
      this.ctx.drawImage(toDraw, 0, 0, this.canvas.width, this.canvas.height);
      toDraw.close();
      this.renderedFrames++;
    }
  }

  private reportTime(clock: number) {
    const now = performance.now();
    if (now - this.lastTimeReportMs < TIME_REPORT_INTERVAL_MS) return;
    this.lastTimeReportMs = now;
    this.cb.onTime?.(Math.min(clock, this.durationSec));
  }

  private handleExpired() {
    if (this.expiredSignaled) return; // one refresh per load
    this.expiredSignaled = true;
    report('warn', 'player', 'stream url expired (403) — requesting fresh playurl');
    this.cb.onExpired?.();
  }

  private checkEnded(clock: number) {
    if (
      this.videoDone &&
      this.audioDone &&
      this.vIdx >= this.encodedVideo.length &&
      this.aIdx >= this.encodedAudio.length &&
      this.frameQueue.length === 0 &&
      this.decodedAudio.length === 0 &&
      clock >= this.durationSec - 0.3
    ) {
      if (this.state !== 'ended') {
        this.setState('ended');
        this.pauseAudioOutput({ pauseSink: true });
      }
    }
  }

  private manageBackpressure() {
    if (this.seeking) return; // don't fight the seek's pause/seekTo/resume sequence
    if (!this.wantPlaying) {
      this.pauseFetchers();
      return;
    }
    const clock = this.getMediaTime();
    this.applyBackpressure(this.videoDemuxer, this.encodedVideo, clock);
    this.applyBackpressure(this.audioDemuxer, this.encodedAudio, clock);
    // Reclaim memory from already-decoded encoded samples.
    if (this.vIdx > 600) {
      this.encodedVideo.splice(0, this.vIdx);
      this.vIdx = 0;
    }
    if (this.aIdx > 1200) {
      this.encodedAudio.splice(0, this.aIdx);
      this.aIdx = 0;
    }
  }

  private applyBackpressure(dmx: Demuxer | null, buf: EncodedSample[], clock: number) {
    if (!dmx) return;
    const last = buf[buf.length - 1];
    if (!last) return;
    const ahead = last.timestamp / 1e6 - clock;
    if (ahead > BUFFER_HIGH) dmx.pause();
    else if (ahead < BUFFER_LOW) dmx.resume();
  }

  private installInterruptionHandlers() {
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('pagehide', this.onPageHide);
    document.addEventListener('freeze', this.onPageFreeze);
    window.addEventListener('blur', this.onWindowBlur);
    this.installMediaSessionHandlers();
  }

  private removeInterruptionHandlers() {
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    window.removeEventListener('pagehide', this.onPageHide);
    document.removeEventListener('freeze', this.onPageFreeze);
    window.removeEventListener('blur', this.onWindowBlur);
    this.clearMediaSessionHandlers();
  }

  private installMediaSessionHandlers() {
    const session = navigator.mediaSession;
    if (!session) return;
    try {
      session.setActionHandler('play', () => this.play());
      session.setActionHandler('pause', () => this.pauseForInterruption('media session pause'));
      session.setActionHandler('stop', () => this.pauseForInterruption('media session stop'));
    } catch {
      /* media-session actions are optional per browser */
    }
  }

  private clearMediaSessionHandlers() {
    const session = navigator.mediaSession;
    if (!session) return;
    try {
      session.setActionHandler('play', null);
      session.setActionHandler('pause', null);
      session.setActionHandler('stop', null);
    } catch {
      /* ignore */
    }
  }

  // ---------- controls ----------

  play() {
    this.wantPlaying = true;
    this.resumeFetchers();
    if (this.ctxStartTime === null) {
      // Not primed yet — maybePrime will start playback. But this call usually
      // comes from a user gesture, so spend it now to unlock the audio pipeline;
      // maybePrime's resumeAudio runs outside any gesture and would be blocked.
      void this.resumeAudioContext().catch(() => {});
      void this.audioEl.play().catch(() => {});
      return;
    }
    if (this.state === 'ended') {
      void this.seek(0); // replay from the start
      return;
    }
    this.resumeAudio();
  }

  pause() {
    this.wantPlaying = false;
    this.pauseFetchers();
    if (this.ctxStartTime !== null || this.state === 'buffering') {
      this.pauseAudioOutput({ pauseSink: true });
      if (this.state !== 'ended' && this.state !== 'error') this.setState('paused');
    }
  }

  private pauseForInterruption(reason: string) {
    if (this.destroyed || (!this.wantPlaying && this.state !== 'playing' && this.state !== 'buffering')) return;
    report('info', 'player', `pausing playback: ${reason}`);
    this.wantPlaying = false;
    this.pauseFetchers();
    this.pauseAudioOutput({ pauseSink: true });
    if (this.state !== 'ended' && this.state !== 'error') {
      this.setState('paused');
    }
  }

  togglePlay() {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  setVolume(v: number) {
    this.volume = Math.max(0, Math.min(1, v));
    this.gain.gain.value = this.volume;
  }

  async seek(seconds: number) {
    if (!this.videoDemuxer || !this.audioDemuxer) return;
    const t = Math.max(0, Math.min(seconds, this.durationSec));
    this.seeking = true;
    this.setState('buffering');

    try {
      await Promise.all([this.videoDemuxer.pauseAndIdle(), this.audioDemuxer.pauseAndIdle()]);
      this.videoDemuxer.seekTo(t);
      this.audioDemuxer.seekTo(t);

      this.resetDecodeState();
      this.baseMediaTime = t;
      this.ctxStartTime = null;

      this.videoDemuxer.resume();
      this.audioDemuxer.resume();
    } finally {
      this.seeking = false;
    }
  }

  private resetDecodeState() {
    this.stopAllAudio();
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.videoDone = false;
    this.audioDone = false;
    this.lastAudioScheduledSec = 0;
    this.nextAudioStartTime = 0;

    // Reset + reconfigure decoders so the next samples start from a keyframe.
    try {
      this.videoDecoder?.reset();
    } catch {
      /* ignore */
    }
    try {
      this.audioDecoder?.reset();
    } catch {
      /* ignore */
    }
    if (this.videoConfig) this.configureVideo(this.videoConfig);
    if (this.audioConfig) this.configureAudio(this.audioConfig);
    this.needVideoKey = true;
  }

  private stopAllAudio() {
    for (const src of this.activeSources) {
      try {
        src.onended = null;
        src.stop();
      } catch {
        /* ignore */
      }
    }
    this.activeSources.clear();
  }

  // ---------- teardown ----------

  private teardownPipeline() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    if (this.audioTimer) clearInterval(this.audioTimer);
    this.audioTimer = 0;
    this.videoDemuxer?.destroy();
    this.audioDemuxer?.destroy();
    this.videoDemuxer = null;
    this.audioDemuxer = null;
    this.stopAllAudio();
    for (const f of this.frameQueue) f.close();
    this.frameQueue = [];
    for (const d of this.decodedAudio) d.close();
    this.decodedAudio = [];
    this.encodedVideo = [];
    this.encodedAudio = [];
    this.vIdx = 0;
    this.aIdx = 0;
    this.videoDone = false;
    this.audioDone = false;
    this.canvasSized = false;
    try {
      if (this.videoDecoder && this.videoDecoder.state !== 'closed') this.videoDecoder.close();
    } catch {
      /* ignore */
    }
    try {
      if (this.audioDecoder && this.audioDecoder.state !== 'closed') this.audioDecoder.close();
    } catch {
      /* ignore */
    }
    this.videoDecoder = null;
    this.audioDecoder = null;
  }

  destroy() {
    this.destroyed = true;
    this.removeInterruptionHandlers();
    this.teardownPipeline();
    this.audioEl.removeEventListener('pause', this.onAudioElementPause);
    this.pauseAudioOutput({ pauseSink: true });
    this.audioEl.srcObject = null;
    this.audioEl.remove();
    this.audioCtx.onstatechange = null;
    void this.audioCtx.close();
    this.setState('idle');
  }

  // ---------- helpers ----------

  getState(): PlayerState {
    return this.state;
  }

  /** Live playback stats for the debug overlay. FPS is measured between calls. */
  getStats() {
    const now = performance.now();
    const dt = Math.max(1, now - this.statsMark.t) / 1000;
    const renderFps = (this.renderedFrames - this.statsMark.rendered) / dt;
    const decodeFps = (this.decodedFrames - this.statsMark.decoded) / dt;
    this.statsMark = { t: now, rendered: this.renderedFrames, decoded: this.decodedFrames };

    const clock = this.getMediaTime();
    const lastV = this.encodedVideo[this.encodedVideo.length - 1];
    return {
      state: this.state,
      renderFps: Math.round(renderFps),
      decodeFps: Math.round(decodeFps),
      queued: this.frameQueue.length,
      decodeQueue: this.videoDecoder?.decodeQueueSize ?? 0,
      dropped: this.droppedFrames,
      bufferedVideoSec: lastV ? +Math.max(0, lastV.timestamp / 1e6 - clock).toFixed(1) : 0,
      bufferedAudioSec: +Math.max(0, this.lastAudioScheduledSec - clock).toFixed(1),
      resolution: this.videoConfig ? `${this.videoConfig.codedWidth}x${this.videoConfig.codedHeight}` : '',
      codec: this.videoConfig?.codec ?? '',
      currentSec: +clock.toFixed(1),
    };
  }

  debugInfo() {
    return {
      state: this.state,
      encVideo: this.encodedVideo.length,
      vIdx: this.vIdx,
      encAudio: this.encodedAudio.length,
      aIdx: this.aIdx,
      frames: this.frameQueue.length,
      decAudio: this.decodedAudio.length,
      videoDone: this.videoDone,
      audioDone: this.audioDone,
      ctxStart: this.ctxStartTime,
      base: this.baseMediaTime,
      vDec: this.videoDecoder?.state,
      aDec: this.audioDecoder?.state,
    };
  }

  private setState(s: PlayerState) {
    if (this.state === s) return;
    this.state = s;
    this.setMediaSessionState(s);
    this.cb.onStateChange?.(s);
  }

  private setMediaSessionState(s: PlayerState) {
    const session = navigator.mediaSession;
    if (!session) return;
    try {
      session.playbackState = s === 'playing' ? 'playing' : s === 'idle' ? 'none' : 'paused';
    } catch {
      /* ignore */
    }
  }

  private fail(message: string) {
    report('error', 'player', message);
    this.cb.onError?.(message);
    this.setState('error');
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function audioContextClass(): typeof AudioContext {
  return (
    window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  );
}

function createAudioContext(sampleRate?: number): AudioContext {
  const Ctor = audioContextClass();
  const opts: AudioContextOptions = { latencyHint: 'playback' };
  if (sampleRate) opts.sampleRate = sampleRate;

  try {
    return new Ctor(opts);
  } catch {
    if (sampleRate) {
      try {
        return new Ctor({ sampleRate });
      } catch {
        /* fall through */
      }
    }
    return new Ctor();
  }
}

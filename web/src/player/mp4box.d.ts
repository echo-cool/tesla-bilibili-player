// Minimal ambient types for the subset of mp4box.js we use.
declare module 'mp4box' {
  export interface MP4MediaTrack {
    id: number;
    codec: string;
    timescale: number;
    duration: number;
    nb_samples: number;
  }
  export interface MP4VideoTrack extends MP4MediaTrack {
    video: { width: number; height: number };
  }
  export interface MP4AudioTrack extends MP4MediaTrack {
    audio: { sample_rate: number; channel_count: number; sample_size: number };
  }
  export interface MP4Info {
    duration: number;
    timescale: number;
    isFragmented: boolean;
    videoTracks: MP4VideoTrack[];
    audioTracks: MP4AudioTrack[];
    tracks: MP4MediaTrack[];
  }
  export interface MP4Sample {
    number: number;
    track_id: number;
    timescale: number;
    is_sync: boolean;
    cts: number;
    dts: number;
    duration: number;
    size: number;
    data: Uint8Array;
  }
  export interface MP4ArrayBuffer extends ArrayBuffer {
    fileStart: number;
  }
  export interface MP4File {
    onReady?: (info: MP4Info) => void;
    onError?: (e: string) => void;
    onSamples?: (id: number, user: unknown, samples: MP4Sample[]) => void;
    appendBuffer(data: MP4ArrayBuffer): number;
    start(): void;
    stop(): void;
    flush(): void;
    seek(time: number, useRap: boolean): { offset: number; time: number };
    setExtractionOptions(id: number, user?: unknown, opts?: { nbSamples?: number }): void;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getTrackById(id: number): any;
    releaseUsedSamples(id: number, sampleNumber: number): void;
  }
  export function createFile(): MP4File;
  export class DataStream {
    constructor(buffer?: ArrayBuffer, byteOffset?: number, endianness?: boolean);
    static BIG_ENDIAN: boolean;
    static LITTLE_ENDIAN: boolean;
    buffer: ArrayBuffer;
  }
}

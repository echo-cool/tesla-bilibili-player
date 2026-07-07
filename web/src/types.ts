// Shared types — mirror the backend JSON contract in server/src/routes/api.ts.

export interface User {
  mid: number;
  uname: string;
  face: string;
}

export interface VideoCard {
  bvid: string;
  aid?: number;
  cid?: number;
  title: string;
  cover: string;
  author: string;
  authorMid?: number;
  duration?: number; // seconds
  views?: number;
  progress?: number; // seconds watched (for "continue watching")
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

/** A single DASH representation. `url` is already wrapped through /api/stream. */
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

export interface QualityOption {
  id: number;
  label: string;
}

export interface PlayUrl {
  videos: Track[];
  audios: Track[];
  qualities: QualityOption[];
  currentQn: number;
  durationSec: number;
}

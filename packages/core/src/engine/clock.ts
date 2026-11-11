import { isGecko } from "../util";
import type { ResolvedTickOptions } from "../types";
import type { AnimationEngineInstance } from "./instance";
import { getCSSDurationInMs } from "./cssValues";

// Gecko has been seen to step media time about every 40 ms, so a read can lag by up to one step (never
// lead), and that lag would reseek lines as drift. A read off by more than a step plus margin is treated as
// a seek or a timer spike.
export const SMOOTH_PLAYBACK_CLOCK = isGecko();
export const CLOCK_RESYNC_THRESHOLD_S = 0.06;
const CLOCK_SLEW_PER_S = 0.1;

export const NO_PLAYER_SNAPSHOT = -1;

interface PlaybackClock {
  lastTime: number;
  lastPlayState: boolean;
  lastEventCreationTime: number;
  smoothedTime: number;
  smoothedAt: number;
}

export const playbackClock: PlaybackClock = {
  lastTime: 0,
  lastPlayState: false,
  lastEventCreationTime: NO_PLAYER_SNAPSHOT,
  smoothedTime: 0,
  smoothedAt: NO_PLAYER_SNAPSHOT,
};

/**
 * Clears the shared playback history when switching songs.
 */
export function resetPlaybackClock(): void {
  playbackClock.lastTime = 0;
  playbackClock.lastPlayState = false;
  playbackClock.lastEventCreationTime = NO_PLAYER_SNAPSHOT;
  playbackClock.smoothedAt = NO_PLAYER_SNAPSHOT;
}

export function smoothedPlaybackTime(
  previousTime: number,
  previousAt: number,
  rawTime: number,
  now: number,
  playbackRate: number
): number {
  if (previousAt === NO_PLAYER_SNAPSHOT) return rawTime;
  const elapsedS = Math.max(0, now - previousAt) / 1000;
  const predictedTime = previousTime + elapsedS * playbackRate;
  const errorS = rawTime - predictedTime;
  if (errorS >= 0 || Math.abs(errorS) >= CLOCK_RESYNC_THRESHOLD_S) return rawTime;
  return predictedTime + errorS * Math.min(1, elapsedS * CLOCK_SLEW_PER_S);
}

const TIME_JUMP_THRESHOLD_S = 0.5;

export interface Playhead {
  timeS: number;
  isPlaying: boolean;
  jumped: boolean;
  mediaClockRanBackwards: boolean;
  seekedWhilePaused: boolean;
}

export function advancePlaybackClock(
  reportedTimeS: number,
  { isPlaying, eventCreationTime, followPausedSeeks }: ResolvedTickOptions,
  playbackRate: number,
  now: number
): Playhead {
  const snapshotGapS = (eventCreationTime - playbackClock.lastEventCreationTime) / 1000;
  const jumped = Math.abs(reportedTimeS - playbackClock.lastTime - snapshotGapS) > TIME_JUMP_THRESHOLD_S;
  const readsMediaClockDirectly = eventCreationTime === NO_PLAYER_SNAPSHOT;
  const mediaClockRanBackwards =
    readsMediaClockDirectly && isPlaying && reportedTimeS < playbackClock.lastTime - CLOCK_RESYNC_THRESHOLD_S;
  const seekedWhilePaused =
    followPausedSeeks && !isPlaying && !playbackClock.lastPlayState && reportedTimeS !== playbackClock.lastTime;

  playbackClock.lastTime = reportedTimeS;
  playbackClock.lastPlayState = isPlaying;
  playbackClock.lastEventCreationTime = eventCreationTime;

  const snapshotAgeS = isPlaying && !readsMediaClockDirectly ? (now - eventCreationTime) / 1000 : 0;
  let timeS = reportedTimeS + snapshotAgeS;
  if (SMOOTH_PLAYBACK_CLOCK) {
    if (isPlaying && !jumped) {
      timeS = smoothedPlaybackTime(playbackClock.smoothedTime, playbackClock.smoothedAt, timeS, now, playbackRate);
    }
    playbackClock.smoothedTime = timeS;
    playbackClock.smoothedAt = isPlaying ? now : NO_PLAYER_SNAPSHOT;
  }
  return { timeS, isPlaying, jumped, mediaClockRanBackwards, seekedWhilePaused };
}

export function lyricClockShiftS(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  options: ResolvedTickOptions
): number {
  const syncTypeShiftS =
    engine.syncType === "richsync"
      ? getCSSDurationInMs(engine, lyricsElement, "--blyrics-richsync-timing-offset") / 1000 -
        options.richsyncOffsetTrim
      : getCSSDurationInMs(engine, lyricsElement, "--blyrics-timing-offset") / 1000 - options.lineOffsetTrim;
  return syncTypeShiftS - options.globalLyricOffset - options.lyricOffset;
}

export function playerTimeForLyricTime(engine: AnimationEngineInstance, lyricTimeS: number): number {
  const options = engine.lastTickOptions;
  const lyricsElement = engine.lyricsContainer;
  if (!options || !lyricsElement) return lyricTimeS;
  return Math.max(0, lyricTimeS - lyricClockShiftS(engine, lyricsElement, options));
}

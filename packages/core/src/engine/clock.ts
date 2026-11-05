import { isGecko } from "../util";
import type { ResolvedTickOptions } from "../types";
import type { AnimationEngineInstance } from "./instance";
import { getCSSDurationInMs } from "./cssValues";

// Gecko steps media time every ~40ms, so reads lag by a random amount (never lead) that reseeks lines as drift.
export const SMOOTH_PLAYBACK_CLOCK = isGecko();
// One Gecko step (~45ms) plus margin: a read further off is a seek or a timer spike, not media lag.
export const CLOCK_RESYNC_THRESHOLD_S = 0.06;
const CLOCK_SLEW_PER_S = 0.1;

/**
 * Stands where a snapshot's wall clock timestamp would be when the time did not come from a live
 * player, and so says nothing about how long ago it was sampled.
 */
export const NO_PLAYER_SNAPSHOT = -1;

/**
 * The last player snapshot. It describes the media, not a view, so every instance reads the same one.
 */
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
 * Forgets the last player snapshot, so the next tick is treated as the first one of a new song
 * rather than as a jump away from the previous one.
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

/**
 * Seconds to add to the player time to get the lyric time this view renders: the theme's offset
 * and the trim for its sync type, less the global and per-song offsets.
 */
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

/**
 * The player time at which a lyric time plays, under the offsets of the last tick.
 */
export function playerTimeForLyricTime(engine: AnimationEngineInstance, lyricTimeS: number): number {
  const options = engine.lastTickOptions;
  const lyricsElement = engine.lyricsContainer;
  if (!options || !lyricsElement) return lyricTimeS;
  return Math.max(0, lyricTimeS - lyricClockShiftS(engine, lyricsElement, options));
}

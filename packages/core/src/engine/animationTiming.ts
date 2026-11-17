import type { AnimationData, LineData, PartData } from "../inject";
import { positiveModulo, toMs } from "../util";
import type { AnimationEngineInstance } from "./instance";

export interface SongClockTrack {
  offsetMs: number;
  appliedTimingOffsetMs: number;
  skipDriftSample?: boolean;
  wrapDurationMs?: number;
}

export interface DriftSample {
  actualTimeMs: number;
  appliedTimingOffsetMs: number;
  biasOffsetMs: number;
  expectedTimeMs: number;
  offsetMs: number;
  playState: AnimationPlayState;
}

const songClockTracks = new WeakMap<Animation, SongClockTrack>();

// A current time set before an animation starts holds until its first frame, which a long setup frame delays.
export function seekAnimation(engine: AnimationEngineInstance, animation: Animation, timeMs: number): void {
  const rate = animation.playbackRate;
  if (!engine.lastTickOptions?.isPlaying || typeof animation.timeline?.currentTime !== "number" || rate === 0) {
    animation.currentTime = timeMs;
    return;
  }
  animation.startTime = performance.now() - timeMs / rate;
}

// The timeline's time is held per task and per frame, so a running animation is read against now, the clock it was placed on.
function liveCurrentTimeMs(animation: Animation): number | null {
  const startTimeMs = animation.startTime;
  if (animation.playState === "running" && typeof startTimeMs === "number") {
    return (performance.now() - startTimeMs) * animation.playbackRate;
  }
  return timingValueToMs(animation.currentTime);
}

export function followSongClock(
  engine: AnimationEngineInstance,
  animation: Animation,
  track: Omit<SongClockTrack, "appliedTimingOffsetMs"> & { appliedTimingOffsetMs?: number }
): Animation {
  songClockTracks.set(animation, {
    ...track,
    appliedTimingOffsetMs: track.appliedTimingOffsetMs ?? engine.learnedAnimationTimingOffsetMs,
  });
  animation.playbackRate = engine.playbackRate;
  return animation;
}

/** Repeats a word's own animations on the cells of a sweep drawn for it from copies of its line. */
export function mirrorHighlightAnimations(part: PartData, animations: Animation[]): Animation[] {
  const target = part.sweepContext?.host;
  if (!target) return [];
  const mirrors: Animation[] = [];
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect | null;
    if (!effect || effect.target !== part.highlightElement) continue;
    const mirror = target.animate(effect.getKeyframes(), effect.getTiming());
    mirror.playbackRate = animation.playbackRate;
    if (animation.playState === "running" && animation.startTime !== null) mirror.startTime = animation.startTime;
    else mirror.currentTime = animation.currentTime;
    const track = songClockTracks.get(animation);
    if (track) songClockTracks.set(mirror, { ...track, skipDriftSample: true });
    mirrors.push(mirror);
  }
  return mirrors;
}

export function applyPlaybackRateToRunningAnimations(engine: AnimationEngineInstance): void {
  const followRate = (animations: Animation[]) => {
    for (const animation of animations) {
      if (songClockTracks.has(animation)) animation.playbackRate = engine.playbackRate;
    }
  };
  for (const line of engine.lines) {
    followRate(line.animations);
    for (const part of line.parts) followRate(part.animations);
  }
}

export function correctedAnimationTimeMs(
  targetTimeMs: number,
  appliedTimingOffsetMs: number,
  maxTimeMs?: number
): number {
  const scheduledTimeMs = targetTimeMs - appliedTimingOffsetMs;
  return maxTimeMs === undefined ? scheduledTimeMs : Math.min(scheduledTimeMs, maxTimeMs);
}

export function correctedWrappedAnimationTimeMs(
  targetTimeMs: number,
  appliedTimingOffsetMs: number,
  wrapDurationMs: number
): number {
  return positiveModulo(targetTimeMs - appliedTimingOffsetMs, wrapDurationMs);
}

export function correctedScrollTimeS(engine: AnimationEngineInstance, lyricTimeS: number): number {
  return lyricTimeS - engine.learnedAnimationTimingOffsetMs / 1000;
}

export function largestDriftSample(line: LineData, lyricTimeS: number): DriftSample | null {
  let largest = accumulateLargestDriftSample(line, lyricTimeS, null);
  for (const part of line.parts) largest = accumulateLargestDriftSample(part, lyricTimeS, largest);
  return largest;
}

function accumulateLargestDriftSample(
  part: AnimationData,
  lyricTimeS: number,
  largest: DriftSample | null
): DriftSample | null {
  for (const animation of part.animations) {
    const sample = driftSample(part, animation, lyricTimeS);
    if (sample && (!largest || Math.abs(sample.offsetMs) > Math.abs(largest.offsetMs))) largest = sample;
  }
  return largest;
}

function driftSample(part: AnimationData, animation: Animation, lyricTimeS: number): DriftSample | null {
  const track = songClockTracks.get(animation);
  if (!track || track.skipDriftSample || animation.playState === "idle") return null;

  const rawActualTimeMs = liveCurrentTimeMs(animation);
  if (rawActualTimeMs === null) return null;
  const expectedTimeMs = normalizedTimeMs(animation, (lyricTimeS - part.time) * 1000 + track.offsetMs, track);
  const actualTimeMs = normalizedTimeMs(animation, rawActualTimeMs, track);
  if (expectedTimeMs === null || actualTimeMs === null) return null;

  const wrapDurationMs = track.wrapDurationMs ?? 0;
  const offsetMs =
    wrapDurationMs > 0 ? wrappedOffsetMs(actualTimeMs, expectedTimeMs, wrapDurationMs) : actualTimeMs - expectedTimeMs;
  return {
    actualTimeMs,
    appliedTimingOffsetMs: track.appliedTimingOffsetMs,
    biasOffsetMs: offsetMs + track.appliedTimingOffsetMs,
    expectedTimeMs,
    offsetMs,
    playState: animation.playState,
  };
}

function normalizedTimeMs(animation: Animation, timeMs: number, track: SongClockTrack): number | null {
  if (!Number.isFinite(timeMs) || timeMs < 0) return null;
  if (track.wrapDurationMs && track.wrapDurationMs > 0) return positiveModulo(timeMs, track.wrapDurationMs);
  // Clamp to the effect's endTime, including delay/endDelay. Clamping to duration can hide drift in delayed
  // letter waves.
  const endTimeMs = timingValueToMs(animation.effect?.getComputedTiming().endTime);
  return endTimeMs !== null && Number.isFinite(endTimeMs) ? Math.min(timeMs, endTimeMs) : timeMs;
}

function wrappedOffsetMs(actualTimeMs: number, expectedTimeMs: number, wrapDurationMs: number): number {
  return positiveModulo(actualTimeMs - expectedTimeMs + wrapDurationMs / 2, wrapDurationMs) - wrapDurationMs / 2;
}

function timingValueToMs(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) || value === Number.POSITIVE_INFINITY ? value : null;
  if (typeof value === "string") {
    const durationMs = toMs(value);
    return durationMs > 0 ? durationMs : null;
  }
  const numeric = value as { to?: (unit: string) => { value?: unknown } } | null;
  if (typeof numeric?.to !== "function") return null;
  try {
    const ms = numeric.to("ms").value;
    return typeof ms === "number" && Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

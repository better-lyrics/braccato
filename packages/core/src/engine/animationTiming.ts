import type { AnimationData, LineData, PartData } from "../inject";
import { clamp, positiveModulo, toMs } from "../util";
import type { AnimationEngineInstance } from "./instance";

const ANIMATION_TIMING_LEARN_RATE = 0.08;
const ANIMATION_TIMING_LEARN_SAMPLE_LIMIT_MS = 80;
const ANIMATION_TIMING_MAX_LEARNED_OFFSET_MS = 80;

export interface AnimationTimingTrack {
  offsetMs: number;
  // Per-letter siblings run on the same clock as the animation sampled for their word, so sampling
  // every one of them each frame finds nothing new.
  skipDriftSample?: boolean;
  appliedTimingOffsetMs: number;
  wrapDurationMs?: number;
}

export interface NativeAnimationTimingSample {
  actualTimeMs: number;
  appliedTimingOffsetMs: number;
  biasOffsetMs: number;
  expectedTimeMs: number;
  offsetMs: number;
  playState: AnimationPlayState;
}

const animationTimingTracks = new WeakMap<Animation, AnimationTimingTrack>();

export function mirrorImageHighlightAnimations(part: PartData, animations: Animation[]): Animation[] {
  const target = part.imageLayers?.highlight;
  if (!target) return [];
  const mirrors: Animation[] = [];
  for (const animation of animations) {
    const effect = animation.effect as KeyframeEffect | null;
    if (!effect || effect.target !== part.highlightElement) continue;
    const mirror = target.animate(effect.getKeyframes(), effect.getTiming());
    mirror.playbackRate = animation.playbackRate;
    mirror.currentTime = animation.currentTime;
    const timing = animationTimingTracks.get(animation);
    if (timing) animationTimingTracks.set(mirror, { ...timing, skipDriftSample: true });
    mirrors.push(mirror);
  }
  return mirrors;
}

export function trackLyricAnimationTiming(
  engine: AnimationEngineInstance,
  animation: Animation,
  timing: Omit<AnimationTimingTrack, "appliedTimingOffsetMs"> & { appliedTimingOffsetMs?: number }
): Animation {
  animationTimingTracks.set(animation, {
    ...timing,
    appliedTimingOffsetMs: timing.appliedTimingOffsetMs ?? engine.learnedAnimationTimingOffsetMs,
  });
  // Being tracked is what makes an animation the song's rather than the interface's, so it is also
  // what decides which ones follow the song's rate.
  animation.playbackRate = engine.playbackRate;
  return animation;
}

/**
 * Puts the animations already running onto a new rate. Setting `playbackRate` keeps `currentTime`,
 * so each one carries on from where the song left it rather than restarting.
 */
export function applyPlaybackRateToRunningAnimations(engine: AnimationEngineInstance): void {
  for (const line of engine.lines) {
    for (const animation of line.animations) {
      if (animationTimingTracks.has(animation)) animation.playbackRate = engine.playbackRate;
    }
    for (const part of line.parts) {
      for (const animation of part.animations) {
        if (animationTimingTracks.has(animation)) animation.playbackRate = engine.playbackRate;
      }
    }
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

export function correctedScrollTimeS(engine: AnimationEngineInstance, currentTime: number): number {
  return currentTime - engine.learnedAnimationTimingOffsetMs / 1000;
}

function timingValueToMs(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) || value === Number.POSITIVE_INFINITY ? value : null;
  }

  if (typeof value === "string") {
    const durationMs = toMs(value);
    return durationMs > 0 ? durationMs : null;
  }

  if (!value || typeof value !== "object") {
    return null;
  }

  const numericValue = value as { to?: (unit: string) => { value?: unknown } };
  if (typeof numericValue.to !== "function") {
    return null;
  }

  try {
    const msValue = numericValue.to("ms").value;
    return typeof msValue === "number" && Number.isFinite(msValue) ? msValue : null;
  } catch (_err) {
    return null;
  }
}

function animationCurrentTimeMs(animation: Animation): number | null {
  return timingValueToMs(animation.currentTime);
}

// A finished animation's currentTime stops at its end time, which counts the delay, so that is where
// the expected time has to stop too. Clamping to the active duration alone saturates a delayed
// animation as soon as it is created and hides any drift in it.
function animationEndTimeMs(animation: Animation): number | null {
  return timingValueToMs(animation.effect?.getComputedTiming().endTime);
}

function wrappedTimingOffsetMs(actualTimeMs: number, expectedTimeMs: number, wrapDurationMs: number): number {
  return positiveModulo(actualTimeMs - expectedTimeMs + wrapDurationMs / 2, wrapDurationMs) - wrapDurationMs / 2;
}

function normalizeAnimationTimeMs(animation: Animation, timeMs: number, timing: AnimationTimingTrack): number | null {
  if (!Number.isFinite(timeMs) || timeMs < 0) {
    return null;
  }

  if (timing.wrapDurationMs && timing.wrapDurationMs > 0) {
    return positiveModulo(timeMs, timing.wrapDurationMs);
  }

  const endTimeMs = animationEndTimeMs(animation);
  if (endTimeMs !== null && Number.isFinite(endTimeMs)) {
    return Math.min(timeMs, endTimeMs);
  }

  return timeMs;
}

function animationTimingSample(
  part: AnimationData,
  animation: Animation,
  currentTime: number
): NativeAnimationTimingSample | null {
  const timing = animationTimingTracks.get(animation);
  if (!timing || timing.skipDriftSample) {
    return null;
  }

  if (animation.playState === "idle") {
    return null;
  }

  const actualTimeMs = animationCurrentTimeMs(animation);
  if (actualTimeMs === null) {
    return null;
  }

  const rawExpectedTimeMs = (currentTime - part.time) * 1000 + timing.offsetMs;
  const expectedTimeMs = normalizeAnimationTimeMs(animation, rawExpectedTimeMs, timing);
  const normalizedActualTimeMs = normalizeAnimationTimeMs(animation, actualTimeMs, timing);
  if (expectedTimeMs === null || normalizedActualTimeMs === null) {
    return null;
  }

  const offsetMs =
    timing.wrapDurationMs && timing.wrapDurationMs > 0
      ? wrappedTimingOffsetMs(normalizedActualTimeMs, expectedTimeMs, timing.wrapDurationMs)
      : normalizedActualTimeMs - expectedTimeMs;
  const biasOffsetMs = offsetMs + timing.appliedTimingOffsetMs;

  return {
    actualTimeMs: normalizedActualTimeMs,
    appliedTimingOffsetMs: timing.appliedTimingOffsetMs,
    biasOffsetMs,
    expectedTimeMs,
    offsetMs,
    playState: animation.playState,
  };
}

function largestNativeTimingSample(part: AnimationData, currentTime: number): NativeAnimationTimingSample | null {
  let largestSample: NativeAnimationTimingSample | null = null;

  for (const animation of part.animations) {
    const sample = animationTimingSample(part, animation, currentTime);
    if (sample === null) {
      continue;
    }
    if (largestSample === null || Math.abs(sample.offsetMs) > Math.abs(largestSample.offsetMs)) {
      largestSample = sample;
    }
  }

  return largestSample;
}

export function lineNativeTimingSample(lineData: LineData, currentTime: number): NativeAnimationTimingSample | null {
  let largestSample: NativeAnimationTimingSample | null = null;

  for (const part of [lineData, ...lineData.parts]) {
    const sample = largestNativeTimingSample(part, currentTime);
    if (sample === null) {
      continue;
    }
    if (largestSample === null || Math.abs(sample.offsetMs) > Math.abs(largestSample.offsetMs)) {
      largestSample = sample;
    }
  }

  return largestSample;
}

export function canUseTimingSampleForDrift(sample: NativeAnimationTimingSample, isPlaying: boolean): boolean {
  if (!isPlaying) {
    return false;
  }

  return sample.playState === "running" || sample.playState === "finished";
}

export function learnAnimationTimingOffset(
  engine: AnimationEngineInstance,
  sample: NativeAnimationTimingSample
): number {
  if (Math.abs(sample.biasOffsetMs) > ANIMATION_TIMING_LEARN_SAMPLE_LIMIT_MS) {
    return engine.learnedAnimationTimingOffsetMs;
  }

  engine.learnedAnimationTimingOffsetMs = clamp(
    engine.learnedAnimationTimingOffsetMs +
      (sample.biasOffsetMs - engine.learnedAnimationTimingOffsetMs) * ANIMATION_TIMING_LEARN_RATE,
    -ANIMATION_TIMING_MAX_LEARNED_OFFSET_MS,
    ANIMATION_TIMING_MAX_LEARNED_OFFSET_MS
  );

  return engine.learnedAnimationTimingOffsetMs;
}

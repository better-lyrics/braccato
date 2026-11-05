import { registerThemeSetting } from "../themeSettings";
import type { LineData } from "../inject";
import { roundedMs } from "../util";
import type { AnimationEngineInstance } from "./instance";
import type { NativeAnimationTimingSample } from "./animationTiming";

const ENABLE_ANIMATION_TIMING_LOGS = registerThemeSetting("blyrics-debug-animation-timing", false);
const ANIMATION_TIMING_LOG_WINDOW_MS = 3000;
const ANIMATION_TIMING_LOG_INTERVAL_MS = 750;
const ANIMATION_TIMING_LOG_THRESHOLD_MS = 30;
export const ANIMATION_TIMING_RESET_THRESHOLD_MS = 100;
export const ANIMATION_TIMING_ACCUMULATION_DECAY = 1.08;
export const ANIMATION_TIMING_ACCUMULATION_WEIGHT = 0.4;

const animationTimingLastLogTimes = new WeakMap<LineData, number>();

function linePreview(lineData: LineData): string {
  return lineData.lyricElement.textContent?.trim().replace(/\s+/g, " ").slice(0, 80) ?? "";
}

export function shouldLogAnimationTiming(
  engine: AnimationEngineInstance,
  lineData: LineData,
  sample: NativeAnimationTimingSample,
  now: number
): boolean {
  if (!ENABLE_ANIMATION_TIMING_LOGS.getBooleanValue()) {
    return false;
  }

  const isVisibilityLogWindow = now < engine.animationTimingVisibilityLogUntil;
  if (!isVisibilityLogWindow && Math.abs(sample.offsetMs) < ANIMATION_TIMING_LOG_THRESHOLD_MS) {
    return false;
  }

  const lastLogTime = animationTimingLastLogTimes.get(lineData) ?? 0;
  if (now - lastLogTime < ANIMATION_TIMING_LOG_INTERVAL_MS) {
    return false;
  }

  animationTimingLastLogTimes.set(lineData, now);
  return true;
}

export function logAnimationTiming(
  engine: AnimationEngineInstance,
  reason: string,
  lineData: LineData,
  lineIndex: number,
  sample: NativeAnimationTimingSample,
  currentTime: number,
  accumulatedOffsetMs: number,
  learnedOffsetMs = engine.learnedAnimationTimingOffsetMs,
  residualOffsetMs = sample.offsetMs
): void {
  if (!ENABLE_ANIMATION_TIMING_LOGS.getBooleanValue()) {
    return;
  }

  engine.host.log("WAAPI timing", {
    reason,
    lineIndex,
    lineTimeS: roundedMs(lineData.time * 1000) / 1000,
    mediaTimeS: roundedMs(currentTime * 1000) / 1000,
    actualTimeMs: roundedMs(sample.actualTimeMs),
    expectedTimeMs: roundedMs(sample.expectedTimeMs),
    offsetMs: roundedMs(sample.offsetMs),
    learnedOffsetMs: roundedMs(learnedOffsetMs),
    appliedTimingOffsetMs: roundedMs(sample.appliedTimingOffsetMs),
    biasOffsetMs: roundedMs(sample.biasOffsetMs),
    residualOffsetMs: roundedMs(residualOffsetMs),
    accumulatedOffsetMs: roundedMs(accumulatedOffsetMs),
    playState: sample.playState,
    text: linePreview(lineData),
  });
}

export function logAnimationCleanup(
  engine: AnimationEngineInstance,
  reason: string,
  lineData: LineData,
  lineIndex: number,
  currentTime: number,
  staleAnimationEndTime: number
): void {
  if (!ENABLE_ANIMATION_TIMING_LOGS.getBooleanValue()) {
    return;
  }

  engine.host.log("Animation cleanup", {
    reason,
    lineIndex,
    lineTimeS: roundedMs(lineData.time * 1000) / 1000,
    mediaTimeS: roundedMs(currentTime * 1000) / 1000,
    staleAnimationEndTimeS: roundedMs(staleAnimationEndTime * 1000) / 1000,
    runningAnimationCount: [lineData, ...lineData.parts].reduce((count, part) => count + part.animations.length, 0),
    text: linePreview(lineData),
  });
}

export function noteVisibilityChange(engine: AnimationEngineInstance): void {
  if (!ENABLE_ANIMATION_TIMING_LOGS.getBooleanValue()) {
    return;
  }

  if (!engine.lyricsContainer) return;

  const runningAnimationCount = engine.lines.reduce(
    (count, line) => count + [line, ...line.parts].reduce((lineCount, part) => lineCount + part.animations.length, 0),
    0
  );

  if (engine.document.visibilityState === "visible") {
    engine.animationTimingVisibilityLogUntil = Date.now() + ANIMATION_TIMING_LOG_WINDOW_MS;
    engine.host.log("Visibility changed; keeping WAAPI animations for timing verification", {
      visibilityState: engine.document.visibilityState,
      runningAnimationCount,
      resetSkipped: true,
      timingLogWindowMs: ANIMATION_TIMING_LOG_WINDOW_MS,
    });
    return;
  }

  engine.host.log("Visibility changed; WAAPI animations left intact", {
    visibilityState: engine.document.visibilityState,
    runningAnimationCount,
    resetSkipped: true,
  });
}

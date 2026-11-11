import { clamp, isGecko } from "../util";
import type { AnimationConfig } from "./animationConfig";

export interface SwipeRamp {
  easing: string;
  startFrom: string;
  startTo: string;
  endFrom: string;
  endTo: string;
}

export interface LetterSwipeWindow {
  delayMs: number;
  durationMs: number;
  from: { start: number; end: number };
  to: { start: number; end: number };
}

export interface LetterWaveTiming {
  delayMs: number;
  durationMs: number;
}

export const LETTER_WAVE_CREST_OFFSET = 0.4;

// WebRender redraws a cached tile only after a quarter device pixel of movement, so Gecko letters step.
// An invisible additive opacity ripple changes every frame and forces the redraw.
export const GECKO_REDRAW = isGecko();
export const GECKO_REDRAW_KEYFRAMES: Keyframe[] = [{ opacity: 0 }, { opacity: -0.002 }, { opacity: 0 }];
export const GECKO_REDRAW_PERIOD_MS = 200;

export function swipeRamp({ highlight }: AnimationConfig): SwipeRamp {
  return {
    easing: highlight.swipeEasing,
    startFrom: highlight.swipeStartFrom,
    startTo: highlight.swipeStartTo,
    endFrom: highlight.swipeEndFrom,
    endTo: highlight.swipeEndTo,
  };
}

export function linearForwardSwipeWindows(
  swipe: SwipeRamp,
  letterCount: number,
  swipeDurationMs: number
): LetterSwipeWindow[] | null {
  if (swipe.easing !== "linear" || swipeDurationMs <= 0 || letterCount <= 0) return null;

  const startFrom = Number.parseFloat(swipe.startFrom);
  const startTo = Number.parseFloat(swipe.startTo);
  const endFrom = Number.parseFloat(swipe.endFrom);
  const endTo = Number.parseFloat(swipe.endTo);
  const finite = [startFrom, startTo, endFrom, endTo].every(Number.isFinite);
  if (!finite || startTo <= startFrom || endTo <= endFrom) return null;

  const startAt = (timeMs: number) => startFrom + ((startTo - startFrom) * timeMs) / swipeDurationMs;
  const endAt = (timeMs: number) => endFrom + ((endTo - endFrom) * timeMs) / swipeDurationMs;
  const timeWhenEndReaches = (value: number) => (swipeDurationMs * (value - endFrom)) / (endTo - endFrom);
  const timeWhenStartReaches = (value: number) => (swipeDurationMs * (value - startFrom)) / (startTo - startFrom);

  const windows: LetterSwipeWindow[] = [];
  for (let index = 0; index < letterCount; index++) {
    const beginMs = clamp(timeWhenEndReaches(index / letterCount), 0, swipeDurationMs);
    const finishMs = clamp(timeWhenStartReaches((index + 1) / letterCount), 0, swipeDurationMs);
    windows.push({
      delayMs: beginMs,
      durationMs: Math.max(finishMs - beginMs, 1),
      from: { start: startAt(beginMs), end: endAt(beginMs) },
      to: { start: startAt(finishMs), end: endAt(finishMs) },
    });
  }
  return windows;
}

export function planLetterWave(
  swipe: SwipeRamp,
  letterCount: number,
  wordDurationMs: number,
  swipeDurationMs: number,
  swipeLeadMs: number,
  floatDurationMs: number
): LetterWaveTiming[] {
  const windows = linearForwardSwipeWindows({ ...swipe, easing: "linear" }, letterCount, swipeDurationMs);
  if (!windows) return evenlySpreadWaves(letterCount, wordDurationMs, floatDurationMs);

  const riseMs = floatDurationMs * LETTER_WAVE_CREST_OFFSET;
  return windows.map(window => {
    const touchedMs = window.delayMs - swipeLeadMs;
    const lightingMs = window.durationMs;
    if (lightingMs > riseMs) return { delayMs: touchedMs, durationMs: lightingMs / LETTER_WAVE_CREST_OFFSET };
    return { delayMs: touchedMs + lightingMs - riseMs, durationMs: floatDurationMs };
  });
}

function evenlySpreadWaves(letterCount: number, wordDurationMs: number, floatDurationMs: number): LetterWaveTiming[] {
  return Array.from({ length: letterCount }, (_, index) => ({
    delayMs: (wordDurationMs * index) / letterCount,
    durationMs: floatDurationMs,
  }));
}

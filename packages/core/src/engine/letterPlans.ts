import { clamp, isGecko } from "../util";
import type { AnimationConfig } from "./animationConfig";

export interface LetterSwipeWindow {
  delayMs: number;
  durationMs: number;
  from: { start: number; end: number };
  to: { start: number; end: number };
}

export interface SwipeRamp {
  easing: string;
  startFrom: string;
  startTo: string;
  endFrom: string;
  endTo: string;
}

// null unless the ramp is linear and forward; planLetterMaskSweep sweeps the whole word instead there.
export function computeLetterSwipeWindows(
  swipe: SwipeRamp,
  letterCount: number,
  swipeDurationMs: number
): LetterSwipeWindow[] | null {
  if (swipe.easing !== "linear" || swipeDurationMs <= 0 || letterCount <= 0) {
    return null;
  }

  const startFrom = Number.parseFloat(swipe.startFrom);
  const startTo = Number.parseFloat(swipe.startTo);
  const endFrom = Number.parseFloat(swipe.endFrom);
  const endTo = Number.parseFloat(swipe.endTo);
  if (![startFrom, startTo, endFrom, endTo].every(Number.isFinite) || startTo <= startFrom || endTo <= endFrom) {
    return null;
  }

  const startAt = (timeMs: number): number => startFrom + ((startTo - startFrom) * timeMs) / swipeDurationMs;
  const endAt = (timeMs: number): number => endFrom + ((endTo - endFrom) * timeMs) / swipeDurationMs;
  const timeWhereEnd = (value: number): number => (swipeDurationMs * (value - endFrom)) / (endTo - endFrom);
  const timeWhereStart = (value: number): number => (swipeDurationMs * (value - startFrom)) / (startTo - startFrom);

  const windows: LetterSwipeWindow[] = [];
  for (let index = 0; index < letterCount; index++) {
    const beginMs = clamp(timeWhereEnd(index / letterCount), 0, swipeDurationMs);
    const finishMs = clamp(timeWhereStart((index + 1) / letterCount), 0, swipeDurationMs);
    windows.push({
      delayMs: beginMs,
      durationMs: Math.max(finishMs - beginMs, 1),
      from: { start: startAt(beginMs), end: endAt(beginMs) },
      to: { start: startAt(finishMs), end: endAt(finishMs) },
    });
  }
  return windows;
}

export interface LetterMaskKeyframe {
  offset: number;
  maskPosition: string;
}

export interface LetterMaskSweep {
  keyframes: LetterMaskKeyframe[];
  delayMs: number;
  durationMs: number;
  easing: string;
}

// Per-letter mask reveal. A linear forward ramp keeps the short windowed animations so a settled letter
// holds a finished one; any other easing runs the same geometry over the whole duration, letting the
// theme easing warp when each letter reveals, so it ends revealed rather than swept past.
export function planLetterMaskSweep(
  swipe: SwipeRamp,
  letterCount: number,
  swipeDurationMs: number,
  rtl: boolean
): LetterMaskSweep[] {
  if (letterCount <= 0) return [];
  const windows = computeLetterSwipeWindows({ ...swipe, easing: "linear" }, letterCount, swipeDurationMs);
  if (!windows) return [];

  const maskSpan = letterCount + 2;
  const maskPositionAt = (start: number, index: number): string => {
    const q = (0.5 * maskSpan - (start * letterCount - index)) / (maskSpan - 1);
    return `${(rtl ? 1 - q : q) * 100}% 0%`;
  };
  const linear = swipe.easing === "linear";
  const durationMs = swipeDurationMs > 0 ? swipeDurationMs : 1;

  return windows.map((window, index) => {
    const from = maskPositionAt(window.from.start, index);
    const to = maskPositionAt(window.to.start, index);
    if (linear) {
      return {
        keyframes: [
          { offset: 0, maskPosition: from },
          { offset: 1, maskPosition: to },
        ],
        delayMs: window.delayMs,
        durationMs: window.durationMs,
        easing: "linear",
      };
    }
    const revealStart = clamp(window.delayMs / durationMs, 0, 1);
    const revealEnd = clamp((window.delayMs + window.durationMs) / durationMs, 0, 1);
    const keyframes: LetterMaskKeyframe[] = [{ offset: 0, maskPosition: from }];
    if (revealStart > 0) keyframes.push({ offset: revealStart, maskPosition: from });
    if (revealEnd > revealStart) keyframes.push({ offset: revealEnd, maskPosition: to });
    if (revealEnd < 1) keyframes.push({ offset: 1, maskPosition: to });
    return { keyframes, delayMs: 0, durationMs, easing: swipe.easing };
  });
}

export function swipeRamp(config: AnimationConfig): SwipeRamp {
  return {
    easing: config.highlight.swipeEasing,
    startFrom: config.highlight.swipeStartFrom,
    startTo: config.highlight.swipeStartTo,
    endFrom: config.highlight.swipeEndFrom,
    endTo: config.highlight.swipeEndTo,
  };
}

// How far through its float a letter crests, as a keyframe offset.
export const LETTER_WAVE_CREST_OFFSET = 0.4;

// WebRender redraws a cached tile only after a quarter device pixel of movement, so Gecko letters step.
// An invisible additive opacity ripple changes every frame and forces the redraw.
export const GECKO_REDRAW = isGecko();
export const GECKO_REDRAW_KEYFRAMES: Keyframe[] = [{ opacity: 0 }, { opacity: -0.002 }, { opacity: 0 }];
export const GECKO_REDRAW_PERIOD_MS = 200;

export interface LetterWaveTiming {
  delayMs: number;
  durationMs: number;
}

// When each letter's wave starts, counted from the start of the word, and how long it lasts. A letter
// crests just as the swipe finishes lighting it. If the swipe lights it faster than the float rises,
// it starts early enough to make that, which on a short word means before the word itself does. If the
// swipe lights it slower, it starts as the swipe touches it and its float stretches to crest on time.
export function planLetterWave(
  swipe: SwipeRamp,
  letterCount: number,
  wordDurationMs: number,
  swipeDurationMs: number,
  swipeLeadMs: number,
  floatDurationMs: number
): LetterWaveTiming[] {
  const riseMs = floatDurationMs * LETTER_WAVE_CREST_OFFSET;
  const windows = computeLetterSwipeWindows({ ...swipe, easing: "linear" }, letterCount, swipeDurationMs);
  const timings: LetterWaveTiming[] = [];
  for (let index = 0; index < letterCount; index++) {
    if (!windows) {
      // No windows for this ramp, so spread the letters evenly over the word.
      timings.push({ delayMs: (wordDurationMs * index) / letterCount, durationMs: floatDurationMs });
      continue;
    }
    // The swipe runs swipeLeadMs ahead of the word, so take the lead back off.
    const touchedMs = windows[index].delayMs - swipeLeadMs;
    const litMs = touchedMs + windows[index].durationMs;
    if (litMs - riseMs > touchedMs) {
      timings.push({ delayMs: touchedMs, durationMs: (litMs - touchedMs) / LETTER_WAVE_CREST_OFFSET });
    } else {
      timings.push({ delayMs: litMs - riseMs, durationMs: floatDurationMs });
    }
  }
  return timings;
}

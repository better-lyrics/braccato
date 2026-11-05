import type { LineData } from "../inject";
import { INSTRUMENTAL_WAVE_PATH_HIGH, INSTRUMENTAL_WAVE_PATH_LOW } from "../instrumental";
import type { AnimationConfig } from "./animationConfig";
import {
  correctedAnimationTimeMs,
  correctedWrappedAnimationTimeMs,
  trackLyricAnimationTiming,
} from "./animationTiming";
import type { AnimationEngineInstance } from "./instance";

const FILL_SELECTOR = ".blyrics--instrumental-fill";
const WAVE_CLIP_SELECTOR = ".blyrics--wave-clip";
const WAVE_PATH_SELECTOR = ".blyrics--wave-path";
const INSTANT_MS = 1;
export const INSTRUMENTAL_WAVE_PATH_HIGH_FALLBACK = `path("${INSTRUMENTAL_WAVE_PATH_HIGH}")`;
export const INSTRUMENTAL_WAVE_PATH_LOW_FALLBACK = `path("${INSTRUMENTAL_WAVE_PATH_LOW}")`;

export function startInstrumentalAnimations(
  engine: AnimationEngineInstance,
  line: LineData,
  config: AnimationConfig,
  lyricTimeS: number,
  appliedTimingOffsetMs: number
): void {
  const elapsedMs = (lyricTimeS - line.time) * 1000;
  const lineDurationMs = Math.max(line.duration * 1000, 1);
  const enabled = config.enabled.instrumental;
  const { instrumental } = config;
  const followSong = (animation: Animation | null, currentTimeMs: number, wrapDurationMs?: number) => {
    if (!animation) return;
    trackLyricAnimationTiming(engine, animation, { appliedTimingOffsetMs, offsetMs: 0, wrapDurationMs });
    animation.currentTime = currentTimeMs;
  };
  const scheduled = (durationMs: number) => correctedAnimationTimeMs(elapsedMs, appliedTimingOffsetMs, durationMs);

  const fillFadeMs = enabled ? instrumental.fillFadeDurationMs : INSTANT_MS;
  const fillFade = animateChild(line, FILL_SELECTOR, [{ opacity: 0 }, { opacity: 1 }], {
    duration: fillFadeMs,
    easing: enabled ? instrumental.fillFadeEasing : "linear",
    fill: "forwards",
  });
  followSong(fillFade, scheduled(fillFadeMs));
  if (!enabled) return;

  const travel = (selector: string, from: string, to: string, easing: string) =>
    animateChild(line, selector, [{ transform: from }, { transform: to }], {
      duration: lineDurationMs,
      easing,
      fill: "both",
    });
  followSong(
    travel(WAVE_CLIP_SELECTOR, instrumental.fillFrom, instrumental.fillTo, instrumental.fillEasing),
    scheduled(lineDurationMs)
  );
  followSong(
    travel(WAVE_PATH_SELECTOR, instrumental.waveFrom, instrumental.waveTo, instrumental.waveEasing),
    scheduled(lineDurationMs)
  );

  const oscillationMs = instrumental.waveOscillationDurationMs;
  const oscillation = animateChild(
    line,
    WAVE_PATH_SELECTOR,
    [{ d: instrumental.wavePathHigh }, { d: instrumental.wavePathLow, offset: 0.5 }, { d: instrumental.wavePathHigh }],
    { duration: oscillationMs, easing: instrumental.waveOscillationEasing, iterations: Infinity }
  );
  const wrapMs = Math.max(oscillationMs, 1);
  followSong(oscillation, correctedWrappedAnimationTimeMs(elapsedMs, appliedTimingOffsetMs, wrapMs), oscillationMs);
}

export function startInstrumentalExitAnimations(line: LineData, config: AnimationConfig, lyricTimeS: number): void {
  if (lyricTimeS < line.time) return;
  const fades = config.enabled.instrumental && config.enabled.highlightFade;
  animateChild(line, FILL_SELECTOR, [{ opacity: 1 }, { opacity: 0 }], {
    duration: fades ? config.highlight.fadeOutDurationMs : INSTANT_MS,
    easing: config.enabled.instrumental ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });
}

function animateChild(
  line: LineData,
  selector: string,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions
): Animation | null {
  const element = line.lyricElement.querySelector(selector);
  if (!element) return null;
  const animation = element.animate(keyframes, options);
  line.animations.push(animation);
  return animation;
}

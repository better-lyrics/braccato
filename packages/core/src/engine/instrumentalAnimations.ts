import { INSTRUMENTAL_WAVE_PATH_HIGH, INSTRUMENTAL_WAVE_PATH_LOW } from "../instrumental";
import type { LineData } from "../inject";
import type { AnimationEngineInstance } from "./instance";
import {
  type AnimationTimingTrack,
  correctedAnimationTimeMs,
  correctedWrappedAnimationTimeMs,
  trackLyricAnimationTiming,
} from "./animationTiming";
import type { AnimationConfig } from "./animationConfig";

const INSTRUMENTAL_FILL_SELECTOR = ".blyrics--instrumental-fill";
const INSTRUMENTAL_WAVE_CLIP_SELECTOR = ".blyrics--wave-clip";
const INSTRUMENTAL_WAVE_PATH_SELECTOR = ".blyrics--wave-path";
export const INSTRUMENTAL_WAVE_PATH_HIGH_FALLBACK = `path("${INSTRUMENTAL_WAVE_PATH_HIGH}")`;
export const INSTRUMENTAL_WAVE_PATH_LOW_FALLBACK = `path("${INSTRUMENTAL_WAVE_PATH_LOW}")`;

function animateInstrumentalChild(
  engine: AnimationEngineInstance,
  lineData: LineData,
  selector: string,
  keyframes: Keyframe[],
  options: KeyframeAnimationOptions,
  timing?: AnimationTimingTrack
): Animation | null {
  const element = lineData.lyricElement.querySelector(selector) as Element | null;
  if (!element) return null;

  const animation = timing
    ? trackLyricAnimationTiming(engine, element.animate(keyframes, options), timing)
    : element.animate(keyframes, options);
  lineData.animations.push(animation);
  return animation;
}

export function startInstrumentalAnimations(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number,
  appliedTimingOffsetMs: number
): void {
  const rawElapsedMs = (currentTime - lineData.time) * 1000;
  const durationMs = Math.max(lineData.duration * 1000, 1);
  const fillFadeDuration = config.enabled.instrumental ? config.instrumental.fillFadeDurationMs : 1;

  const fillAnimation = animateInstrumentalChild(
    engine,
    lineData,
    INSTRUMENTAL_FILL_SELECTOR,
    [{ opacity: 0 }, { opacity: 1 }],
    {
      duration: fillFadeDuration,
      easing: config.enabled.instrumental ? config.instrumental.fillFadeEasing : "linear",
      fill: "forwards",
    },
    { appliedTimingOffsetMs, offsetMs: 0 }
  );

  let fillTravelAnimation: Animation | null = null;
  let waveFlattenAnimation: Animation | null = null;
  let waveOscillationAnimation: Animation | null = null;
  if (config.enabled.instrumental) {
    fillTravelAnimation = animateInstrumentalChild(
      engine,
      lineData,
      INSTRUMENTAL_WAVE_CLIP_SELECTOR,
      [{ transform: config.instrumental.fillFrom }, { transform: config.instrumental.fillTo }],
      {
        duration: durationMs,
        easing: config.instrumental.fillEasing,
        fill: "both",
      },
      { appliedTimingOffsetMs, offsetMs: 0 }
    );

    waveFlattenAnimation = animateInstrumentalChild(
      engine,
      lineData,
      INSTRUMENTAL_WAVE_PATH_SELECTOR,
      [{ transform: config.instrumental.waveFrom }, { transform: config.instrumental.waveTo }],
      {
        duration: durationMs,
        easing: config.instrumental.waveEasing,
        fill: "both",
      },
      { appliedTimingOffsetMs, offsetMs: 0 }
    );

    waveOscillationAnimation = animateInstrumentalChild(
      engine,
      lineData,
      INSTRUMENTAL_WAVE_PATH_SELECTOR,
      [
        { d: config.instrumental.wavePathHigh },
        { d: config.instrumental.wavePathLow, offset: 0.5 },
        { d: config.instrumental.wavePathHigh },
      ],
      {
        duration: config.instrumental.waveOscillationDurationMs,
        easing: config.instrumental.waveOscillationEasing,
        iterations: Infinity,
      },
      {
        appliedTimingOffsetMs,
        offsetMs: 0,
        wrapDurationMs: config.instrumental.waveOscillationDurationMs,
      }
    );
  }

  if (fillAnimation) {
    fillAnimation.currentTime = correctedAnimationTimeMs(rawElapsedMs, appliedTimingOffsetMs, fillFadeDuration);
  }
  for (const animation of [fillTravelAnimation, waveFlattenAnimation]) {
    if (animation) {
      animation.currentTime = correctedAnimationTimeMs(rawElapsedMs, appliedTimingOffsetMs, durationMs);
    }
  }
  if (waveOscillationAnimation) {
    waveOscillationAnimation.currentTime = correctedWrappedAnimationTimeMs(
      rawElapsedMs,
      appliedTimingOffsetMs,
      Math.max(config.instrumental.waveOscillationDurationMs, 1)
    );
  }
}

export function startInstrumentalExitAnimations(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number
): void {
  if (currentTime < lineData.time) return;

  const fadeDuration =
    config.enabled.instrumental && config.enabled.highlightFade ? config.highlight.fadeOutDurationMs : 1;
  animateInstrumentalChild(engine, lineData, INSTRUMENTAL_FILL_SELECTOR, [{ opacity: 1 }, { opacity: 0 }], {
    duration: fadeDuration,
    easing: config.enabled.instrumental ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });
}

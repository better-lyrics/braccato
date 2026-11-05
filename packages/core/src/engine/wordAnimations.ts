import { RTL_CLASS } from "../constants";
import type { PartData } from "../inject";
import { registerThemeSetting } from "../themeSettings";
import type { AnimationConfig } from "./animationConfig";
import { correctedAnimationTimeMs, mirrorImageHighlightAnimations, trackLyricAnimationTiming } from "./animationTiming";
import {
  fadeInFullySweptKeyframes,
  fadeOutKeyframes,
  glowKeyframes,
  shownFullySweptKeyframes,
  shownKeyframes,
  swipeKeyframes,
} from "./highlightKeyframes";
import type { AnimationEngineInstance } from "./instance";
import {
  GECKO_REDRAW,
  GECKO_REDRAW_KEYFRAMES,
  GECKO_REDRAW_PERIOD_MS,
  LETTER_WAVE_CREST_OFFSET,
  type LetterWaveTiming,
  planLetterMaskSweep,
  planLetterWave,
  swipeRamp,
} from "./letterPlans";
import { resetPartAnimations } from "./lineAnimationState";
import { acquireWaveAnimation } from "./wavePool";

const SWIPE_LEAD_RATIO = registerThemeSetting("blyrics-swipe-lead-ratio", 0.1);
const SWIPE_DURATION_RATIO = registerThemeSetting("blyrics-swipe-duration-ratio", 1.6);
const LINE_SYNCED_WORD_CLASS = "blyrics-line-synced-word";
const INSTANT_MS = 1;

export interface HeldPaint {
  target: HTMLElement;
  frame: Keyframe;
}

interface WordTimeline {
  engine: AnimationEngineInstance;
  part: PartData;
  config: AnimationConfig;
  appliedTimingOffsetMs: number;
  elapsedMs: number;
  durationMs: number;
  swipeLeadMs: number;
  swipeDurationMs: number;
  glowDurationMs: number;
}

interface LetterWaveRun {
  waves: LetterWaveTiming[];
  keyframes: Keyframe[];
  signature: string;
  headStartMs: number;
  lastEndingWaveIndex: number;
  startAtMs: number;
}

export function startWordAnimations(
  engine: AnimationEngineInstance,
  part: PartData,
  config: AnimationConfig,
  lyricTimeS: number,
  appliedTimingOffsetMs: number
): void {
  resetPartAnimations(part);
  const word = wordTimeline(engine, part, config, lyricTimeS, appliedTimingOffsetMs);
  const highlight = part.lyricElement.classList.contains(LINE_SYNCED_WORD_CLASS)
    ? lineSyncedHighlight(word)
    : richSyncedHighlight(word);
  const motion = config.enabled.wordWobble ? [...wobble(word), ...letterWave(word)] : [];
  part.animations = [...highlight, ...mirrorImageHighlightAnimations(part, highlight), ...motion];
}

export function startWordExitAnimation(part: PartData, config: AnimationConfig, heldPaint: HeldPaint[] = []): void {
  resetPartAnimations(part);
  const fades = config.enabled.highlightFade;
  const durationMs = fades ? config.highlight.fadeOutDurationMs : INSTANT_MS;
  const fadeOut = part.highlightElement.animate(fadeOutKeyframes(config, part), {
    duration: durationMs,
    easing: fades ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });
  const mirrors = mirrorImageHighlightAnimations(part, [fadeOut]);
  const holds = heldPaint.map(({ target, frame }) =>
    target.animate([frame, frame], { duration: durationMs, fill: "none" })
  );
  part.animations = [fadeOut, ...mirrors, ...holds];
  fadeOut.addEventListener("finish", () => resetPartAnimations(part), { once: true });
}

function wordTimeline(
  engine: AnimationEngineInstance,
  part: PartData,
  config: AnimationConfig,
  lyricTimeS: number,
  appliedTimingOffsetMs: number
): WordTimeline {
  const durationMs = Math.max(0, part.duration * 1000);
  return {
    engine,
    part,
    config,
    appliedTimingOffsetMs,
    elapsedMs: (lyricTimeS - part.time) * 1000,
    durationMs,
    swipeLeadMs: durationMs * SWIPE_LEAD_RATIO.getNumberValue(),
    swipeDurationMs: durationMs * SWIPE_DURATION_RATIO.getNumberValue(),
    glowDurationMs: Math.max(durationMs * config.highlight.glowDurationRatio, config.highlight.glowMinDurationMs),
  };
}

function scheduledTimeMs(word: WordTimeline, elapsedMs: number, durationMs: number): number {
  return correctedAnimationTimeMs(elapsedMs, word.appliedTimingOffsetMs, durationMs);
}

interface SongClockOptions {
  offsetMs?: number;
  skipDriftSample?: boolean;
}

function followSong(
  word: WordTimeline,
  animation: Animation,
  currentTimeMs: number,
  { offsetMs = 0, skipDriftSample = false }: SongClockOptions = {}
): Animation {
  const { appliedTimingOffsetMs } = word;
  trackLyricAnimationTiming(word.engine, animation, { appliedTimingOffsetMs, offsetMs, skipDriftSample });
  animation.currentTime = currentTimeMs;
  return animation;
}

function glowShows(part: PartData, config: AnimationConfig): boolean {
  return config.enabled.highlightGlow && !part.glowSuppressed;
}

function richSyncedHighlight(word: WordTimeline): Animation[] {
  const { part, config } = word;
  const animations = config.enabled.highlightSwipe ? swipe(word) : [];
  const shown = config.enabled.highlightSwipe ? shownKeyframes() : shownFullySweptKeyframes(config);
  const show = part.highlightElement.animate(shown, { duration: INSTANT_MS, easing: "linear", fill: "forwards" });
  animations.push(followSong(word, show, scheduledTimeMs(word, word.elapsedMs, INSTANT_MS)));
  if (glowShows(part, config)) animations.push(glow(word, word.glowDurationMs));
  return animations;
}

function lineSyncedHighlight(word: WordTimeline): Animation[] {
  const { part, config } = word;
  const fades = config.enabled.highlightFade;
  const durationMs = fades ? config.highlight.fadeInDurationMs : INSTANT_MS;
  const fadeIn = part.highlightElement.animate(fadeInFullySweptKeyframes(config), {
    duration: durationMs,
    easing: fades ? config.highlight.fadeInEasing : "linear",
    fill: "forwards",
  });
  const animations = [followSong(word, fadeIn, scheduledTimeMs(word, word.elapsedMs, durationMs))];
  if (glowShows(part, config)) animations.push(glow(word, config.highlight.glowMinDurationMs));
  return animations;
}

function swipe(word: WordTimeline): Animation[] {
  const { part, config, swipeLeadMs, swipeDurationMs } = word;
  const currentTimeMs = scheduledTimeMs(word, word.elapsedMs + swipeLeadMs, swipeDurationMs);
  const letters = part.highlightLetterElements;
  if (!letters || letters.length === 0) {
    const gradient = part.highlightElement.animate(swipeKeyframes(config), {
      duration: swipeDurationMs,
      easing: config.highlight.swipeEasing,
      fill: "forwards",
    });
    return [followSong(word, gradient, currentTimeMs, { offsetMs: swipeLeadMs })];
  }

  const rtl = part.highlightElement.classList.contains(RTL_CLASS);
  const sweeps = planLetterMaskSweep(swipeRamp(config), letters.length, swipeDurationMs, rtl);
  const animations: Animation[] = [];
  sweeps.forEach((sweep, index) => {
    const keyframes = sweep.keyframes.map(frame => ({
      offset: frame.offset,
      maskPosition: frame.maskPosition,
      WebkitMaskPosition: frame.maskPosition,
    })) as Keyframe[];
    const timing: KeyframeAnimationOptions = {
      duration: sweep.durationMs,
      delay: sweep.delayMs,
      easing: sweep.easing,
      fill: "both",
    };
    const endsLast = index === sweeps.length - 1;
    const letterSweep = letters[index].animate(keyframes, timing);
    animations.push(
      followSong(word, letterSweep, currentTimeMs, { offsetMs: swipeLeadMs, skipDriftSample: !endsLast })
    );
    const glowLetter = part.imageLayers?.glowLetters[index];
    if (glowLetter) {
      animations.push(
        followSong(word, glowLetter.animate(keyframes, timing), currentTimeMs, {
          offsetMs: swipeLeadMs,
          skipDriftSample: true,
        })
      );
    }
  });
  return animations;
}

function glow(word: WordTimeline, durationMs: number): Animation {
  const { part, config } = word;
  const holdsGlow = Boolean(part.imageLayers) || !config.highlight.glowRestingInvisible;
  const target = part.imageLayers?.glow ?? part.highlightElement;
  const animation = target.animate(glowKeyframes(config, part), {
    duration: durationMs,
    easing: config.highlight.glowEasing,
    fill: holdsGlow ? "forwards" : "none",
  });
  return followSong(word, animation, scheduledTimeMs(word, word.elapsedMs, durationMs));
}

function wobble(word: WordTimeline): Animation[] {
  const { wobbleFrom, wobblePeak, wobblePeakOffset, wobblePeakEasing, wobbleSettle, wobbleSettleOffset } =
    word.config.word;
  const { wobbleTo, wobbleEndEasing, wobbleDurationMs, wobbleEasing } = word.config.word;
  const keyframes: Keyframe[] = [
    { transform: wobbleFrom },
    { transform: wobblePeak, offset: wobblePeakOffset, easing: wobblePeakEasing },
    { transform: wobbleSettle, offset: Math.max(wobblePeakOffset, wobbleSettleOffset) },
    { transform: wobbleTo, easing: wobbleEndEasing },
  ];
  const timing: KeyframeAnimationOptions = { duration: wobbleDurationMs, easing: wobbleEasing, fill: "forwards" };
  const currentTimeMs = scheduledTimeMs(word, word.elapsedMs, wobbleDurationMs);
  return word.part.wobbleElements.map(element => followSong(word, element.animate(keyframes, timing), currentTimeMs));
}

function letterWave(word: WordTimeline): Animation[] {
  const { part, config } = word;
  const letterCount = part.letterElements?.length ?? 0;
  if (letterCount === 0) return [];

  const run = planLetterWaveRun(word, letterCount);
  const glowLetters = glowShows(part, config) ? part.imageLayers?.glowLetters : undefined;
  const glowFadesOut = Number.parseFloat(config.highlight.imageGlowOpacityTo) === 0;
  const glowEndMs = glowFadesOut ? run.headStartMs + word.glowDurationMs : Infinity;

  const animations: Animation[] = [];
  floatLetters(word, run, part.letterElements, Infinity, true, animations);
  floatLetters(word, run, part.highlightLetterElements, Infinity, false, animations);
  floatLetters(word, run, glowLetters, glowEndMs, false, animations);
  return animations;
}

function planLetterWaveRun(word: WordTimeline, letterCount: number): LetterWaveRun {
  const { config } = word;
  const emphasise = word.part.lyricElement.dataset.longWord === "true";
  const emphasisPeak = emphasise ? ` scale(${config.letterWave.emphasisScale})` : "";
  const emphasisRest = emphasise ? " scale(1)" : "";
  const keyframes: Keyframe[] = [
    { transform: `translateY(0)${emphasisRest}`, easing: config.letterWave.riseEasing },
    {
      transform: `${config.letterWave.transform}${emphasisPeak}`,
      offset: LETTER_WAVE_CREST_OFFSET,
      easing: config.letterWave.fallEasing,
    },
    { transform: `${config.letterWave.settle}${emphasisRest}` },
  ];
  const waves = planLetterWave(
    swipeRamp(config),
    letterCount,
    word.durationMs,
    word.swipeDurationMs,
    word.swipeLeadMs,
    config.letterWave.durationMs
  );
  // Carry early starts in the clock offset; negative delays make finished waves appear late to drift sampling.
  const headStartMs = Math.max(0, -Math.min(...waves.map(wave => wave.delayMs)));
  const waveEndsMs = waves.map(wave => wave.delayMs + wave.durationMs);
  const lastWaveEndMs = Math.max(...waveEndsMs);
  return {
    waves,
    keyframes,
    signature: JSON.stringify(keyframes),
    headStartMs,
    lastEndingWaveIndex: waveEndsMs.lastIndexOf(lastWaveEndMs),
    startAtMs: scheduledTimeMs(word, word.elapsedMs + headStartMs, headStartMs + lastWaveEndMs),
  };
}

function floatLetters(
  word: WordTimeline,
  run: LetterWaveRun,
  letters: HTMLElement[] | undefined,
  endMs: number,
  isBaseText: boolean,
  animations: Animation[]
): void {
  letters?.forEach((letterElement, index) => {
    const wave = run.waves[index];
    const delayMs = wave.delayMs + run.headStartMs;
    if (delayMs >= endMs) return;
    const float = acquireWaveAnimation(word.engine, letterElement, run.keyframes, run.signature, {
      duration: wave.durationMs,
      delay: delayMs,
      endDelay: Math.min(0, endMs - delayMs - wave.durationMs),
      fill: "forwards",
    });
    const skipDriftSample = !isBaseText || index !== run.lastEndingWaveIndex;
    animations.push(followSong(word, float, run.startAtMs, { offsetMs: run.headStartMs, skipDriftSample }));
    if (!GECKO_REDRAW || !isBaseText) return;
    const redraw = letterElement.animate(GECKO_REDRAW_KEYFRAMES, {
      duration: GECKO_REDRAW_PERIOD_MS,
      iterations: wave.durationMs / GECKO_REDRAW_PERIOD_MS,
      delay: delayMs,
      composite: "add",
    });
    animations.push(followSong(word, redraw, run.startAtMs, { offsetMs: run.headStartMs, skipDriftSample: true }));
  });
}

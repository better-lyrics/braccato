import { RTL_CLASS } from "../constants";
import type { PartData, SweepCell } from "../inject";
import { registerThemeSetting } from "../themeSettings";
import type { AnimationConfig } from "./animationConfig";
import { correctedAnimationTimeMs, mirrorHighlightAnimations, followSongClock } from "./animationTiming";
import type { AnimationEngineInstance } from "./instance";
import {
  GECKO_REDRAW,
  GECKO_REDRAW_KEYFRAMES,
  GECKO_REDRAW_PERIOD_MS,
  LETTER_WAVE_CREST_OFFSET,
  type LetterWaveTiming,
  planLetterWave,
  swipeRamp,
} from "./letterPlans";
import { resetPartAnimations } from "./lineAnimationState";
import { type CellSpan, cellReachedAt, planCellSweep } from "./sweepPlans";
import { acquireWaveAnimation } from "./wavePool";

const SWIPE_LEAD_RATIO = registerThemeSetting("blyrics-swipe-lead-ratio", 0.1);
const SWIPE_DURATION_RATIO = registerThemeSetting("blyrics-swipe-duration-ratio", 1.6);
const LINE_SYNCED_WORD_CLASS = "blyrics-line-synced-word";
const INSTANT_MS = 1;

// The sweep holds a word's reveal in its own layers, so the word's own opacity is all that animates on it.
const SHOWN: Keyframe[] = [{ opacity: 1 }, { opacity: 1 }];
const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

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
  part.animations = [...highlight, ...mirrorHighlightAnimations(part, highlight), ...motion];
}

export function startWordExitAnimation(part: PartData, config: AnimationConfig): void {
  resetPartAnimations(part);
  const fades = config.enabled.highlightFade;
  const durationMs = fades ? config.highlight.fadeOutDurationMs : INSTANT_MS;
  const fadeOut = part.highlightElement.animate(FADE_OUT, {
    duration: durationMs,
    easing: fades ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });
  part.animations = [fadeOut, ...mirrorHighlightAnimations(part, [fadeOut])];
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
  followSongClock(word.engine, animation, { appliedTimingOffsetMs, offsetMs, skipDriftSample });
  animation.currentTime = currentTimeMs;
  return animation;
}

function glowShows(part: PartData, config: AnimationConfig): boolean {
  return config.enabled.highlightGlow && !part.glowSuppressed;
}

function richSyncedHighlight(word: WordTimeline): Animation[] {
  const { part, config } = word;
  const swipes = config.enabled.highlightSwipe;
  const animations = swipes ? swipe(word) : [];
  const show = part.highlightElement.animate(SHOWN, { duration: INSTANT_MS, easing: "linear", fill: "forwards" });
  animations.push(followSong(word, show, scheduledTimeMs(word, word.elapsedMs, INSTANT_MS)));
  if (glowShows(part, config)) animations.push(...glow(word, word.glowDurationMs, swipes));
  return animations;
}

function lineSyncedHighlight(word: WordTimeline): Animation[] {
  const { part, config } = word;
  const fades = config.enabled.highlightFade;
  const durationMs = fades ? config.highlight.fadeInDurationMs : INSTANT_MS;
  const fadeIn = part.highlightElement.animate(FADE_IN, {
    duration: durationMs,
    easing: fades ? config.highlight.fadeInEasing : "linear",
    fill: "forwards",
  });
  const animations = [followSong(word, fadeIn, scheduledTimeMs(word, word.elapsedMs, durationMs))];
  if (glowShows(part, config)) animations.push(...glow(word, config.highlight.glowMinDurationMs, false));
  return animations;
}

function swipe(word: WordTimeline): Animation[] {
  const { part, swipeLeadMs, swipeDurationMs } = word;
  const currentTimeMs = scheduledTimeMs(word, word.elapsedMs + swipeLeadMs, swipeDurationMs);
  return part.sweep ? compositedSwipe(word, part.sweep, currentTimeMs) : [];
}

/**
 * Slides each cell's mask from where the swipe begins back to its resting place and its text the other
 * way. Filled backwards because the resting pose is the lit one. Only the first mask's animation feeds
 * the drift check; the others carry the same timing and would repeat it.
 */
function compositedSwipe(word: WordTimeline, cells: SweepCell[], currentTimeMs: number): Animation[] {
  const { part, config, swipeLeadMs, swipeDurationMs } = word;
  const rtl = part.highlightElement.classList.contains(RTL_CLASS);
  const timing: KeyframeAnimationOptions = {
    duration: swipeDurationMs,
    easing: config.highlight.swipeEasing,
    fill: "both",
  };
  const animations: Animation[] = [];
  cells.forEach((cell, index) => {
    const span = cell.span ?? { start: index / cells.length, width: 1 / cells.length };
    const plan = planCellSweep(swipeRamp(config), span, rtl);
    if (!plan) return;
    for (const [element, keyframes] of [
      [cell.mask, plan.mask],
      [cell.text, plan.text],
    ] as const) {
      const slide = element.animate(keyframes, timing);
      animations.push(
        followSong(word, slide, currentTimeMs, { offsetMs: swipeLeadMs, skipDriftSample: animations.length > 0 })
      );
    }
  });
  return animations;
}

function glow(word: WordTimeline, durationMs: number, followsSwipe: boolean): Animation[] {
  return word.part.sweep ? sweepGlow(word, word.part.sweep, durationMs, followsSwipe) : [];
}

// Where the shrinking radius reaches the tight halo's, as a fraction of the glow's eased progress.
const TIGHT_GLOW_AT = 0.6;

/**
 * Stands in for a glow whose radius shrinks to nothing: the wide halo crossfades into the tight one
 * while the radius would shrink between them, and the tight one then fades out. The keyframe offsets
 * are in eased progress, since the glow's easing applies to the whole effect. Under a swipe each
 * cell's glow starts when the edge reaches it, so a halo never shows ahead of its lit text. The wait
 * is exact for a linear swipe and taken as linear for any other.
 */
function sweepGlow(word: WordTimeline, cells: SweepCell[], durationMs: number, followsSwipe: boolean): Animation[] {
  const { config, swipeLeadMs, swipeDurationMs } = word;
  const fades = config.highlight.glowRestingInvisible;
  const wide: Keyframe[] = fades
    ? [{ opacity: 1 }, { opacity: 0, offset: TIGHT_GLOW_AT }, { opacity: 0 }]
    : [{ opacity: 1 }, { opacity: 1 }];
  const tight: Keyframe[] = fades
    ? [{ opacity: 0 }, { opacity: 1, offset: TIGHT_GLOW_AT }, { opacity: 0 }]
    : [{ opacity: 0 }, { opacity: 0 }];
  return cells.flatMap((cell, cellIndex) => {
    const span: CellSpan = cell.span ?? { start: cellIndex / cells.length, width: 1 / cells.length };
    const delayMs = followsSwipe
      ? Math.max(0, cellReachedAt(swipeRamp(config), span) * swipeDurationMs - swipeLeadMs)
      : 0;
    const timing: KeyframeAnimationOptions = {
      delay: delayMs,
      duration: durationMs,
      easing: config.highlight.glowEasing,
      fill: fades ? "none" : "forwards",
    };
    const currentTimeMs = scheduledTimeMs(word, word.elapsedMs, delayMs + durationMs);
    return cell.glows.map((halo, index) => {
      const fade = halo.glow.animate(index === 0 ? wide : tight, timing);
      return followSong(word, fade, currentTimeMs, { skipDriftSample: true });
    });
  });
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
  const glowLetterSets = glowShows(part, config)
    ? (part.sweep?.flatMap(cell => cell.glows.map(glow => glow.letters)) ?? [])
    : [];

  const animations: Animation[] = [];
  floatLetters(word, run, part.letterElements, true, animations);
  floatLetters(word, run, part.highlightLetterElements, false, animations);
  for (const glowLetters of glowLetterSets) floatLetters(word, run, glowLetters, false, animations);
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
  isBaseText: boolean,
  animations: Animation[]
): void {
  letters?.forEach((letterElement, index) => {
    const wave = run.waves[index];
    const delayMs = wave.delayMs + run.headStartMs;
    const float = acquireWaveAnimation(word.engine, letterElement, run.keyframes, run.signature, {
      duration: wave.durationMs,
      delay: delayMs,
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

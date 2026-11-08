import { registerThemeSetting } from "../themeSettings";
import type { AnimationEngineInstance } from "./instance";
import { REDUCED_MOTION_QUERY } from "./motionPreference";
import { createThemeReader } from "./cssValues";
import { isGlowRestingInvisible, parseColorAlpha, resolveGlowFilter } from "./glow";
import { INSTRUMENTAL_WAVE_PATH_HIGH_FALLBACK, INSTRUMENTAL_WAVE_PATH_LOW_FALLBACK } from "./instrumentalAnimations";

const EARLY_SCROLL_CONSIDER = registerThemeSetting("blyrics-early-scroll-consider-s", 0.54);

export interface AnimationConfig {
  enabled: {
    lineScale: boolean;
    wordWobble: boolean;
    highlightSwipe: boolean;
    highlightGlow: boolean;
    highlightFade: boolean;
    scroll: boolean;
    instrumental: boolean;
  };
  line: {
    durationMs: number;
    enterEasing: string;
    exitEasing: string;
    enterFrom: string;
    enterTo: string;
    exitFrom: string;
    exitTo: string;
  };
  highlight: {
    fadeInDurationMs: number;
    fadeOutDurationMs: number;
    fadeInEasing: string;
    fadeOutEasing: string;
    swipeEasing: string;
    swipeStartFrom: string;
    swipeEndFrom: string;
    swipeStartTo: string;
    swipeEndTo: string;
    glowTo: string;
    glowDurationRatio: number;
    glowMinDurationMs: number;
    glowEasing: string;
    glowContainerAlpha: number;
    glowRestingInvisible: boolean;
  };
  word: {
    wobbleDurationMs: number;
    wobbleEasing: string;
    wobblePeakEasing: string;
    wobbleEndEasing: string;
    wobbleFrom: string;
    wobblePeak: string;
    wobbleSettle: string;
    wobbleTo: string;
    wobblePeakOffset: number;
    wobbleSettleOffset: number;
  };
  letterWave: {
    transform: string;
    settle: string;
    emphasisScale: string;
    durationMs: number;
    riseEasing: string;
    fallEasing: string;
  };
  instrumental: {
    fillFadeDurationMs: number;
    fillFadeEasing: string;
    fillFrom: string;
    fillTo: string;
    fillEasing: string;
    waveFrom: string;
    waveTo: string;
    waveEasing: string;
    wavePathHigh: string;
    wavePathLow: string;
    waveOscillationDurationMs: number;
    waveOscillationEasing: string;
  };
  lineScroll: {
    easing: string;
    differentialEffects: boolean;
  };
}

export interface AnimationSettings {
  config: AnimationConfig;
  scrollTiming: { earlyScrollConsiderS: number };
}

const DEFAULT_SCROLL_EASING = "cubic-bezier(0.86, 0, 0.2, 1)";

export function getAnimationSettings(engine: AnimationEngineInstance, lyricsElement: HTMLElement): AnimationSettings {
  engine.cachedAnimationSettings ??= {
    config: readAnimationConfig(engine, lyricsElement),
    scrollTiming: { earlyScrollConsiderS: Math.max(0, EARLY_SCROLL_CONSIDER.getNumberValue()) },
  };
  return engine.cachedAnimationSettings;
}

function readAnimationConfig(engine: AnimationEngineInstance, lyricsElement: HTMLElement): AnimationConfig {
  const css = createThemeReader(engine, lyricsElement);
  const glowTo = resolveGlowFilter(engine, lyricsElement, "to", "0");
  return {
    enabled: {
      lineScale: css.flag("--blyrics-animate-line-scale", true),
      wordWobble: css.flag("--blyrics-animate-word-wobble", true),
      highlightSwipe: css.flag("--blyrics-animate-highlight-swipe", true),
      highlightGlow: css.flag("--blyrics-animate-highlight-glow", true),
      highlightFade: css.flag("--blyrics-animate-highlight-fade", true),
      scroll: css.flag("--blyrics-animate-scroll", true),
      instrumental: css.flag("--blyrics-animate-instrumental", true),
    },
    line: {
      durationMs: css.durationMs("--blyrics-scale-transition-duration", "0.166s"),
      enterEasing: css.string("--blyrics-line-enter-easing", "ease"),
      exitEasing: css.string("--blyrics-line-exit-easing", "ease"),
      enterFrom: css.string("--blyrics-line-enter-transform-from", "scale(var(--blyrics-scale))"),
      enterTo: css.string("--blyrics-line-enter-transform-to", "scale(var(--blyrics-active-scale))"),
      exitFrom: css.string("--blyrics-line-exit-transform-from", "scale(var(--blyrics-active-scale))"),
      exitTo: css.string("--blyrics-line-exit-transform-to", "scale(var(--blyrics-scale))"),
    },
    highlight: {
      fadeInDurationMs: css.durationMs("--blyrics-lyric-highlight-fade-in-duration", "0.33s"),
      fadeOutDurationMs: css.durationMs("--blyrics-lyric-highlight-fade-out-duration", "0.5s"),
      fadeInEasing: css.string("--blyrics-lyric-highlight-fade-in-easing", "ease"),
      fadeOutEasing: css.string("--blyrics-lyric-highlight-fade-out-easing", "ease"),
      swipeEasing: css.string("--blyrics-highlight-swipe-easing", "linear"),
      swipeStartFrom: css.string("--blyrics-highlight-swipe-start-from", "-0.2"),
      swipeEndFrom: css.string("--blyrics-highlight-swipe-end-from", "-0.1"),
      swipeStartTo: css.string("--blyrics-highlight-swipe-start-to", "1.4"),
      swipeEndTo: css.string("--blyrics-highlight-swipe-end-to", "1.5"),
      glowTo,
      glowDurationRatio: css.number("--blyrics-highlight-glow-duration-ratio", 1.2),
      glowMinDurationMs: css.durationMs("--blyrics-highlight-glow-min-duration", "1.2s"),
      glowEasing: css.string("--blyrics-highlight-glow-easing", "ease"),
      glowContainerAlpha: parseColorAlpha(css.string("--blyrics-glow-color", "")) ?? 1,
      glowRestingInvisible: isGlowRestingInvisible(glowTo),
    },
    word: {
      wobbleDurationMs: css.durationMs("--blyrics-wobble-duration", "1s"),
      wobbleEasing: css.string("--blyrics-word-wobble-easing", "ease"),
      wobblePeakEasing: css.string("--blyrics-word-wobble-peak-easing", "ease-in-out"),
      wobbleEndEasing: css.string("--blyrics-word-wobble-end-easing", "ease-out"),
      wobbleFrom: css.string("--blyrics-word-wobble-transform-from", "scaleX(1)"),
      wobblePeak: css.string("--blyrics-word-wobble-transform-peak", "translateX(0.05em) scaleX(1.025)"),
      wobbleSettle: css.string("--blyrics-word-wobble-transform-settle", "translateX(0) scaleX(1)"),
      wobbleTo: css.string("--blyrics-word-wobble-transform-to", "scaleX(1)"),
      wobblePeakOffset: css.fraction("--blyrics-word-wobble-peak-offset", 0.125),
      wobbleSettleOffset: css.fraction("--blyrics-word-wobble-settle-offset", 0.75),
    },
    letterWave: {
      transform: css.string("--blyrics-letter-wave-transform", "translateY(-0.06em)"),
      settle: css.string("--blyrics-letter-wave-settle", "translateY(-0.05em)"),
      emphasisScale: css.string("--blyrics-letter-wave-emphasis-scale", "1.08"),
      durationMs: css.durationMs("--blyrics-letter-wave-duration", "0.9s"),
      riseEasing: css.string("--blyrics-letter-wave-rise-easing", "ease-in-out"),
      fallEasing: css.string("--blyrics-letter-wave-fall-easing", "ease-in-out"),
    },
    instrumental: {
      fillFadeDurationMs: css.durationMs("--blyrics-instrumental-fill-fade-duration", "150ms"),
      fillFadeEasing: css.string("--blyrics-instrumental-fill-fade-easing", "ease"),
      fillFrom: css.string("--blyrics-instrumental-fill-transform-from", "translateY(78%)"),
      fillTo: css.string("--blyrics-instrumental-fill-transform-to", "translateY(-4%)"),
      fillEasing: css.string("--blyrics-instrumental-fill-easing", "linear"),
      waveFrom: css.string("--blyrics-instrumental-wave-transform-from", "scaleY(1.2)"),
      waveTo: css.string("--blyrics-instrumental-wave-transform-to", "scaleY(0.0001)"),
      waveEasing: css.string("--blyrics-instrumental-wave-easing", "ease-in"),
      wavePathHigh: css.string("--blyrics-instrumental-wave-path-high", INSTRUMENTAL_WAVE_PATH_HIGH_FALLBACK),
      wavePathLow: css.string("--blyrics-instrumental-wave-path-low", INSTRUMENTAL_WAVE_PATH_LOW_FALLBACK),
      waveOscillationDurationMs: css.durationMs("--blyrics-instrumental-wave-oscillation-duration", "1.25s"),
      waveOscillationEasing: css.string("--blyrics-instrumental-wave-oscillation-easing", "ease-in-out"),
    },
    lineScroll: {
      easing: css.string("--blyrics-lyric-scroll-timing-function", DEFAULT_SCROLL_EASING),
      differentialEffects: !engine.window.matchMedia(REDUCED_MOTION_QUERY).matches,
    },
  };
}

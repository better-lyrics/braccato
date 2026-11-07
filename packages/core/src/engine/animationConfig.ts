import { registerThemeSetting } from "../themeSettings";
import type { AnimationEngineInstance } from "./instance";
import { REDUCED_MOTION_QUERY } from "./motionPreference";
import { getCSSBoolean, getCSSDurationWithFallback, getCSSNumber, getCSSOffset, getCSSValue } from "./cssValues";
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
    imageGlowFrom: string;
    imageGlowTo: string;
    imageGlowOpacityFrom: string;
    imageGlowOpacityTo: string;
    glowFrom: string;
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

function readAnimationConfig(engine: AnimationEngineInstance, lyricsElement: HTMLElement): AnimationConfig {
  const prefersReducedMotion = engine.window.matchMedia(REDUCED_MOTION_QUERY).matches;
  const scrollEasing = getCSSValue(
    engine,
    lyricsElement,
    "--blyrics-lyric-scroll-timing-function",
    "cubic-bezier(0.86, 0, 0.2, 1)"
  );

  return {
    enabled: {
      lineScale: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-line-scale", true),
      wordWobble: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-word-wobble", true),
      highlightSwipe: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-highlight-swipe", true),
      highlightGlow: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-highlight-glow", true),
      highlightFade: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-highlight-fade", true),
      scroll: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-scroll", true),
      instrumental: getCSSBoolean(engine, lyricsElement, "--blyrics-animate-instrumental", true),
    },
    line: {
      durationMs: getCSSDurationWithFallback(engine, lyricsElement, "--blyrics-scale-transition-duration", "0.166s"),
      enterEasing: getCSSValue(engine, lyricsElement, "--blyrics-line-enter-easing", "ease"),
      exitEasing: getCSSValue(engine, lyricsElement, "--blyrics-line-exit-easing", "ease"),
      enterFrom: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-line-enter-transform-from",
        "scale(var(--blyrics-scale))"
      ),
      enterTo: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-line-enter-transform-to",
        "scale(var(--blyrics-active-scale))"
      ),
      exitFrom: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-line-exit-transform-from",
        "scale(var(--blyrics-active-scale))"
      ),
      exitTo: getCSSValue(engine, lyricsElement, "--blyrics-line-exit-transform-to", "scale(var(--blyrics-scale))"),
    },
    highlight: {
      fadeInDurationMs: getCSSDurationWithFallback(
        engine,
        lyricsElement,
        "--blyrics-lyric-highlight-fade-in-duration",
        "0.33s"
      ),
      fadeOutDurationMs: getCSSDurationWithFallback(
        engine,
        lyricsElement,
        "--blyrics-lyric-highlight-fade-out-duration",
        "0.5s"
      ),
      fadeInEasing: getCSSValue(engine, lyricsElement, "--blyrics-lyric-highlight-fade-in-easing", "ease"),
      fadeOutEasing: getCSSValue(engine, lyricsElement, "--blyrics-lyric-highlight-fade-out-easing", "ease"),
      swipeEasing: getCSSValue(engine, lyricsElement, "--blyrics-highlight-swipe-easing", "linear"),
      swipeStartFrom: getCSSValue(engine, lyricsElement, "--blyrics-highlight-swipe-start-from", "-0.2"),
      swipeEndFrom: getCSSValue(engine, lyricsElement, "--blyrics-highlight-swipe-end-from", "-0.1"),
      swipeStartTo: getCSSValue(engine, lyricsElement, "--blyrics-highlight-swipe-start-to", "1.4"),
      swipeEndTo: getCSSValue(engine, lyricsElement, "--blyrics-highlight-swipe-end-to", "1.5"),
      imageGlowFrom: getCSSValue(engine, lyricsElement, "--blyrics-highlight-glow-radius-from", "0.8rem"),
      imageGlowTo: getCSSValue(engine, lyricsElement, "--blyrics-highlight-glow-radius-to", "0px"),
      imageGlowOpacityFrom: getCSSValue(engine, lyricsElement, "--blyrics-image-glow-opacity-from", "0.5"),
      imageGlowOpacityTo: getCSSValue(engine, lyricsElement, "--blyrics-image-glow-opacity-to", "0"),
      glowFrom: resolveGlowFilter(engine, lyricsElement, "from", "0.8rem"),
      glowTo: resolveGlowFilter(engine, lyricsElement, "to", "0"),
      glowDurationRatio: getCSSNumber(engine, lyricsElement, "--blyrics-highlight-glow-duration-ratio", 1.2),
      glowMinDurationMs: getCSSDurationWithFallback(
        engine,
        lyricsElement,
        "--blyrics-highlight-glow-min-duration",
        "1.2s"
      ),
      glowEasing: getCSSValue(engine, lyricsElement, "--blyrics-highlight-glow-easing", "ease"),
      glowContainerAlpha: parseColorAlpha(getCSSValue(engine, lyricsElement, "--blyrics-glow-color", "")) ?? 1,
      glowRestingInvisible: isGlowRestingInvisible(resolveGlowFilter(engine, lyricsElement, "to", "0")),
    },
    word: {
      wobbleDurationMs: getCSSDurationWithFallback(engine, lyricsElement, "--blyrics-wobble-duration", "1s"),
      wobbleEasing: getCSSValue(engine, lyricsElement, "--blyrics-word-wobble-easing", "ease"),
      wobblePeakEasing: getCSSValue(engine, lyricsElement, "--blyrics-word-wobble-peak-easing", "ease-in-out"),
      wobbleEndEasing: getCSSValue(engine, lyricsElement, "--blyrics-word-wobble-end-easing", "ease-out"),
      wobbleFrom: getCSSValue(engine, lyricsElement, "--blyrics-word-wobble-transform-from", "scaleX(1)"),
      wobblePeak: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-word-wobble-transform-peak",
        "translateX(0.05em) scaleX(1.025)"
      ),
      wobbleSettle: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-word-wobble-transform-settle",
        "translateX(0) scaleX(1)"
      ),
      wobbleTo: getCSSValue(engine, lyricsElement, "--blyrics-word-wobble-transform-to", "scaleX(1)"),
      wobblePeakOffset: getCSSOffset(engine, lyricsElement, "--blyrics-word-wobble-peak-offset", 0.125),
      wobbleSettleOffset: getCSSOffset(engine, lyricsElement, "--blyrics-word-wobble-settle-offset", 0.75),
    },
    letterWave: {
      transform: getCSSValue(engine, lyricsElement, "--blyrics-letter-wave-transform", "translateY(-0.06em)"),
      settle: getCSSValue(engine, lyricsElement, "--blyrics-letter-wave-settle", "translateY(-0.05em)"),
      emphasisScale: getCSSValue(engine, lyricsElement, "--blyrics-letter-wave-emphasis-scale", "1.08"),
      durationMs: getCSSDurationWithFallback(engine, lyricsElement, "--blyrics-letter-wave-duration", "0.9s"),
      riseEasing: getCSSValue(engine, lyricsElement, "--blyrics-letter-wave-rise-easing", "ease-in-out"),
      fallEasing: getCSSValue(engine, lyricsElement, "--blyrics-letter-wave-fall-easing", "ease-in-out"),
    },
    instrumental: {
      fillFadeDurationMs: getCSSDurationWithFallback(
        engine,
        lyricsElement,
        "--blyrics-instrumental-fill-fade-duration",
        "150ms"
      ),
      fillFadeEasing: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-fill-fade-easing", "ease"),
      fillFrom: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-fill-transform-from", "translateY(78%)"),
      fillTo: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-fill-transform-to", "translateY(-4%)"),
      fillEasing: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-fill-easing", "linear"),
      waveFrom: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-wave-transform-from", "scaleY(1.2)"),
      waveTo: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-wave-transform-to", "scaleY(0.0001)"),
      waveEasing: getCSSValue(engine, lyricsElement, "--blyrics-instrumental-wave-easing", "ease-in"),
      wavePathHigh: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-instrumental-wave-path-high",
        INSTRUMENTAL_WAVE_PATH_HIGH_FALLBACK
      ),
      wavePathLow: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-instrumental-wave-path-low",
        INSTRUMENTAL_WAVE_PATH_LOW_FALLBACK
      ),
      waveOscillationDurationMs: getCSSDurationWithFallback(
        engine,
        lyricsElement,
        "--blyrics-instrumental-wave-oscillation-duration",
        "1.25s"
      ),
      waveOscillationEasing: getCSSValue(
        engine,
        lyricsElement,
        "--blyrics-instrumental-wave-oscillation-easing",
        "ease-in-out"
      ),
    },
    lineScroll: {
      easing: scrollEasing,
      differentialEffects: !prefersReducedMotion,
    },
  };
}

function readScrollTiming(): { earlyScrollConsiderS: number } {
  return { earlyScrollConsiderS: Math.max(0, EARLY_SCROLL_CONSIDER.getNumberValue()) };
}

export function getAnimationSettings(engine: AnimationEngineInstance, lyricsElement: HTMLElement): AnimationSettings {
  if (!engine.cachedAnimationSettings) {
    const config = readAnimationConfig(engine, lyricsElement);
    engine.cachedAnimationSettings = {
      config,
      scrollTiming: readScrollTiming(),
    };
  }
  return engine.cachedAnimationSettings;
}

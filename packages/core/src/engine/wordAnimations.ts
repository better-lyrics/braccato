import { registerThemeSetting } from "../themeSettings";
import type { PartData } from "../inject";
import { RTL_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import type { AnimationConfig } from "./animationConfig";
import { correctedAnimationTimeMs, mirrorImageHighlightAnimations, trackLyricAnimationTiming } from "./animationTiming";
import {
  GECKO_REDRAW,
  GECKO_REDRAW_KEYFRAMES,
  GECKO_REDRAW_PERIOD_MS,
  LETTER_WAVE_CREST_OFFSET,
  planLetterMaskSweep,
  planLetterWave,
  swipeRamp,
} from "./letterPlans";
import {
  activeTextGlowKeyframes,
  activeTextGradientKeyframes,
  activeTextInstantKeyframes,
  activeTextVisibleKeyframes,
  fadeOutTextKeyframes,
  lineSyncedTextKeyframes,
} from "./textKeyframes";
import { resetPartAnimations } from "./lineAnimationState";
import { acquireWaveAnimation } from "./wavePool";

const SWIPE_LEAD_RATIO = registerThemeSetting("blyrics-swipe-lead-ratio", 0.1);
const SWIPE_DURATION_RATIO = registerThemeSetting("blyrics-swipe-duration-ratio", 1.6);

const LINE_SYNCED_WORD_CLASS = "blyrics-line-synced-word";

interface HighlightAnimations {
  animations: Animation[];
  swipe?: Animation;
  fade?: Animation;
  glow?: Animation;
}

function startRichSyncedHighlightAnimations(
  engine: AnimationEngineInstance,
  part: PartData,
  config: AnimationConfig,
  swipeTimeMs: number,
  wordTimeMs: number,
  swipeDurationMs: number,
  glowDurationMs: number,
  appliedTimingOffsetMs: number
): HighlightAnimations {
  const animations: Animation[] = [];
  const highlight = part.highlightElement;

  let swipeAnimation: Animation | undefined;
  if (config.enabled.highlightSwipe) {
    const swipeTiming = { appliedTimingOffsetMs, offsetMs: swipeTimeMs - wordTimeMs };
    const swipeCurrentTimeMs = correctedAnimationTimeMs(swipeTimeMs, appliedTimingOffsetMs, swipeDurationMs);
    const highlightLetters = part.highlightLetterElements;
    if (highlightLetters && highlightLetters.length > 0) {
      const sweeps = planLetterMaskSweep(
        swipeRamp(config),
        highlightLetters.length,
        swipeDurationMs,
        part.highlightElement.classList.contains(RTL_CLASS)
      );
      sweeps.forEach((sweep, index) => {
        const targets = [highlightLetters[index], part.imageLayers?.glowLetters[index]].filter(
          (target): target is HTMLElement => target !== undefined
        );
        for (const target of targets) {
          const animation = trackLyricAnimationTiming(
            engine,
            target.animate(
              sweep.keyframes.map(frame => ({
                offset: frame.offset,
                maskPosition: frame.maskPosition,
                WebkitMaskPosition: frame.maskPosition,
              })) as Keyframe[],
              { duration: sweep.durationMs, delay: sweep.delayMs, easing: sweep.easing, fill: "both" }
            ),
            // The last letter's sweep ends last, so it alone covers the whole word.
            index === sweeps.length - 1 && target === highlightLetters[index]
              ? swipeTiming
              : { ...swipeTiming, skipDriftSample: true }
          );
          animation.currentTime = swipeCurrentTimeMs;
          if (index === 0) swipeAnimation = animation;
          animations.push(animation);
        }
      });
    } else {
      swipeAnimation = trackLyricAnimationTiming(
        engine,
        highlight.animate(activeTextGradientKeyframes(config), {
          duration: swipeDurationMs,
          easing: config.highlight.swipeEasing,
          fill: "forwards",
        }),
        swipeTiming
      );
      swipeAnimation.currentTime = swipeCurrentTimeMs;
      animations.push(swipeAnimation);
    }
  }

  const opacityAnimation = trackLyricAnimationTiming(
    engine,
    highlight.animate(
      config.enabled.highlightSwipe ? activeTextVisibleKeyframes() : activeTextInstantKeyframes(config),
      {
        duration: 1,
        easing: "linear",
        fill: "forwards",
      }
    ),
    { appliedTimingOffsetMs, offsetMs: 0 }
  );
  opacityAnimation.currentTime = correctedAnimationTimeMs(wordTimeMs, appliedTimingOffsetMs, 1);
  animations.push(opacityAnimation);

  let glowAnimation: Animation | undefined;
  if (config.enabled.highlightGlow && !part.glowSuppressed) {
    glowAnimation = trackLyricAnimationTiming(
      engine,
      (part.imageLayers?.glow ?? highlight).animate(activeTextGlowKeyframes(config, part), {
        duration: glowDurationMs,
        easing: config.highlight.glowEasing,
        fill: part.imageLayers ? "forwards" : config.highlight.glowRestingInvisible ? "none" : "forwards",
      }),
      { appliedTimingOffsetMs, offsetMs: 0 }
    );
    glowAnimation.currentTime = correctedAnimationTimeMs(wordTimeMs, appliedTimingOffsetMs, glowDurationMs);
    animations.push(glowAnimation);
  }

  return { animations, swipe: swipeAnimation, fade: opacityAnimation, glow: glowAnimation };
}

function startLineSyncedHighlightAnimations(
  engine: AnimationEngineInstance,
  part: PartData,
  config: AnimationConfig,
  wordTimeMs: number,
  glowDurationMs: number,
  appliedTimingOffsetMs: number
): HighlightAnimations {
  const animations: Animation[] = [];
  const fadeInDuration = config.enabled.highlightFade ? config.highlight.fadeInDurationMs : 1;
  const highlight = part.highlightElement;

  const opacityAnimation = trackLyricAnimationTiming(
    engine,
    highlight.animate(lineSyncedTextKeyframes(config), {
      duration: fadeInDuration,
      easing: config.enabled.highlightFade ? config.highlight.fadeInEasing : "linear",
      fill: "forwards",
    }),
    { appliedTimingOffsetMs, offsetMs: 0 }
  );
  opacityAnimation.currentTime = correctedAnimationTimeMs(wordTimeMs, appliedTimingOffsetMs, fadeInDuration);
  animations.push(opacityAnimation);

  let glowAnimation: Animation | undefined;
  if (config.enabled.highlightGlow && !part.glowSuppressed) {
    glowAnimation = trackLyricAnimationTiming(
      engine,
      (part.imageLayers?.glow ?? highlight).animate(activeTextGlowKeyframes(config, part), {
        duration: glowDurationMs,
        easing: config.highlight.glowEasing,
        fill: part.imageLayers ? "forwards" : config.highlight.glowRestingInvisible ? "none" : "forwards",
      }),
      { appliedTimingOffsetMs, offsetMs: 0 }
    );
    glowAnimation.currentTime = correctedAnimationTimeMs(wordTimeMs, appliedTimingOffsetMs, glowDurationMs);
    animations.push(glowAnimation);
  }

  return { animations, fade: opacityAnimation, glow: glowAnimation };
}

export function startWordAnimations(
  engine: AnimationEngineInstance,
  part: PartData,
  config: AnimationConfig,
  currentTime: number,
  appliedTimingOffsetMs: number
): void {
  resetPartAnimations(part);

  const rawElapsedMs = (currentTime - part.time) * 1000;
  // Providers do ship words that end before they start: one -0.01s word in a Musixmatch richsync
  // was enough to make animate() throw here, and the throw took the rest of the tick with it, so
  // the line never finished setting up and the engine tried it again on every frame.
  const timedDurationMs = Math.max(0, part.duration * 1000);
  const isLineSyncedWord = part.lyricElement.classList.contains(LINE_SYNCED_WORD_CLASS);
  const swipeLeadMs = timedDurationMs * SWIPE_LEAD_RATIO.getNumberValue();
  const swipeTimeMs = rawElapsedMs + swipeLeadMs;
  const wordTimeMs = rawElapsedMs;
  const swipeDurationMs = timedDurationMs * SWIPE_DURATION_RATIO.getNumberValue();
  const glowDurationMs = Math.max(
    timedDurationMs * config.highlight.glowDurationRatio,
    config.highlight.glowMinDurationMs
  );

  const highlightAnimations = isLineSyncedWord
    ? startLineSyncedHighlightAnimations(
        engine,
        part,
        config,
        wordTimeMs,
        config.highlight.glowMinDurationMs,
        appliedTimingOffsetMs
      )
    : startRichSyncedHighlightAnimations(
        engine,
        part,
        config,
        swipeTimeMs,
        wordTimeMs,
        swipeDurationMs,
        glowDurationMs,
        appliedTimingOffsetMs
      );

  const wobbleAnimations: Animation[] = [];
  if (config.enabled.wordWobble) {
    const wobbleKeyframes: Keyframe[] = [
      { transform: config.word.wobbleFrom },
      {
        transform: config.word.wobblePeak,
        offset: config.word.wobblePeakOffset,
        easing: config.word.wobblePeakEasing,
      },
      {
        transform: config.word.wobbleSettle,
        offset: Math.max(config.word.wobblePeakOffset, config.word.wobbleSettleOffset),
      },
      { transform: config.word.wobbleTo, easing: config.word.wobbleEndEasing },
    ];
    const wobbleOptions: KeyframeAnimationOptions = {
      duration: config.word.wobbleDurationMs,
      easing: config.word.wobbleEasing,
      fill: "forwards",
    };
    const wobbleStartMs = correctedAnimationTimeMs(wordTimeMs, appliedTimingOffsetMs, config.word.wobbleDurationMs);
    for (const wordElement of part.wobbleElements) {
      const animation = trackLyricAnimationTiming(engine, wordElement.animate(wobbleKeyframes, wobbleOptions), {
        appliedTimingOffsetMs,
        offsetMs: 0,
      });
      animation.currentTime = wobbleStartMs;
      wobbleAnimations.push(animation);
    }

    const letters = part.letterElements;
    if (letters && letters.length > 0) {
      const emphasise = part.lyricElement?.dataset.longWord === "true";
      const emphasisPeak = emphasise ? ` scale(${config.letterWave.emphasisScale})` : "";
      const emphasisRest = emphasise ? " scale(1)" : "";
      const floatKeyframes: Keyframe[] = [
        { transform: `translateY(0)${emphasisRest}`, easing: config.letterWave.riseEasing },
        {
          transform: `${config.letterWave.transform}${emphasisPeak}`,
          offset: LETTER_WAVE_CREST_OFFSET,
          easing: config.letterWave.fallEasing,
        },
        { transform: `${config.letterWave.settle}${emphasisRest}` },
      ];
      const letterCount = letters.length;
      const waves = planLetterWave(
        swipeRamp(config),
        letterCount,
        timedDurationMs,
        swipeDurationMs,
        swipeLeadMs,
        config.letterWave.durationMs
      );
      // A letter that starts before the word would have a negative delay, which the drift check reads
      // as the wave running behind once it finishes. Run the wave's clock ahead by the head start
      // instead, the way the swipe carries its lead, so every delay stays at zero or above.
      const waveLeadMs = Math.max(0, -Math.min(...waves.map(wave => wave.delayMs)));
      const waveEndsMs = waves.map(wave => wave.delayMs + wave.durationMs);
      const lastWaveEndMs = Math.max(...waveEndsMs);
      const lastEndingWaveIndex = waveEndsMs.lastIndexOf(lastWaveEndMs);
      const cascadeDurationMs = waveLeadMs + lastWaveEndMs;
      const floatStartMs = correctedAnimationTimeMs(wordTimeMs + waveLeadMs, appliedTimingOffsetMs, cascadeDurationMs);
      const floatKeyframeSignature = JSON.stringify(floatKeyframes);
      // Glow letters only show while the glow does: never when it is off or renders nothing for this
      // word, and not once it has faded out. Their waves stop there instead of running to the end.
      const glowLetters =
        config.enabled.highlightGlow && !part.glowSuppressed ? part.imageLayers?.glowLetters : undefined;
      const glowEndMs =
        Number.parseFloat(config.highlight.imageGlowOpacityTo) === 0 ? waveLeadMs + glowDurationMs : Infinity;
      const animateLetters = (letters: HTMLElement[] | undefined, endMs: number, sampled: boolean) => {
        letters?.forEach((letterElement, index) => {
          const delayMs = waves[index].delayMs + waveLeadMs;
          if (delayMs >= endMs) return;
          const endDelayMs = Math.min(0, endMs - delayMs - waves[index].durationMs);
          const animation = trackLyricAnimationTiming(
            engine,
            acquireWaveAnimation(engine, letterElement, floatKeyframes, floatKeyframeSignature, {
              duration: waves[index].durationMs,
              delay: delayMs,
              endDelay: endDelayMs,
              fill: "forwards",
            }),
            {
              appliedTimingOffsetMs,
              offsetMs: waveLeadMs,
              // The wave that ends last covers the whole word. A theme's swipe ramp can make that an early letter.
              skipDriftSample: !sampled || index !== lastEndingWaveIndex,
            }
          );
          animation.currentTime = floatStartMs;
          wobbleAnimations.push(animation);
          if (!GECKO_REDRAW || !sampled) return;
          const redraw = trackLyricAnimationTiming(
            engine,
            letterElement.animate(GECKO_REDRAW_KEYFRAMES, {
              duration: GECKO_REDRAW_PERIOD_MS,
              iterations: waves[index].durationMs / GECKO_REDRAW_PERIOD_MS,
              delay: delayMs,
              composite: "add",
            }),
            { appliedTimingOffsetMs, offsetMs: waveLeadMs, skipDriftSample: true }
          );
          redraw.currentTime = floatStartMs;
          wobbleAnimations.push(redraw);
        });
      };
      animateLetters(part.letterElements, Infinity, true);
      animateLetters(part.highlightLetterElements, Infinity, false);
      animateLetters(glowLetters, glowEndMs, false);
    }
  }
  part.animations = [
    ...highlightAnimations.animations,
    ...mirrorImageHighlightAnimations(part, highlightAnimations.animations),
    ...wobbleAnimations,
  ];
}

export function startWordExitAnimation(
  part: PartData,
  config: AnimationConfig,
  imagePaint: { target: HTMLElement; frame: Keyframe }[] = []
): void {
  resetPartAnimations(part);

  const fadeDuration = config.enabled.highlightFade ? config.highlight.fadeOutDurationMs : 1;
  const animation = part.highlightElement.animate(fadeOutTextKeyframes(config, part), {
    duration: fadeDuration,
    easing: config.enabled.highlightFade ? config.highlight.fadeOutEasing : "linear",
    fill: "none",
  });

  part.animations = [animation, ...mirrorImageHighlightAnimations(part, [animation])];
  // Keep the current blur, letter masks and motion visible until the parent fade ends.
  for (const { target, frame } of imagePaint) {
    part.animations.push(target.animate([frame, frame], { duration: fadeDuration, fill: "none" }));
  }
  animation.addEventListener(
    "finish",
    () => {
      resetPartAnimations(part);
    },
    { once: true }
  );
}

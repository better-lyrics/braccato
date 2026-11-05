import type { LineData, PartData } from "../inject";
import type { AnimationEngineInstance } from "./instance";
import type { AnimationConfig } from "./animationConfig";
import { resetPartAnimations } from "./lineAnimationState";
import { correctedAnimationTimeMs, trackLyricAnimationTiming } from "./animationTiming";
import { startInstrumentalAnimations, startInstrumentalExitAnimations } from "./instrumentalAnimations";
import { resolveLineGlowSuppression } from "./glow";
import { startWordAnimations, startWordExitAnimation } from "./wordAnimations";

function startLineAnimation(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number,
  appliedTimingOffsetMs: number
): void {
  resetPartAnimations(lineData);

  const rawElapsedMs = (currentTime - lineData.time) * 1000;

  if (!config.enabled.lineScale) {
    lineData.animations = [];
    return;
  }

  const animation = trackLyricAnimationTiming(
    engine,
    lineData.lyricElement.animate([{ transform: config.line.enterFrom }, { transform: config.line.enterTo }], {
      duration: config.line.durationMs,
      easing: config.line.enterEasing,
      fill: "forwards",
    }),
    { appliedTimingOffsetMs, offsetMs: 0 }
  );

  animation.currentTime = correctedAnimationTimeMs(rawElapsedMs, appliedTimingOffsetMs, config.line.durationMs);
  lineData.animations = [animation];
}

function startLineExitAnimation(lineData: LineData, config: AnimationConfig): void {
  resetPartAnimations(lineData);

  if (!config.enabled.lineScale) {
    return;
  }

  const animation = lineData.lyricElement.animate(
    [{ transform: config.line.exitFrom }, { transform: config.line.exitTo }],
    {
      duration: config.line.durationMs,
      easing: config.line.exitEasing,
      fill: "none",
    }
  );

  lineData.animations = [animation];
  animation.addEventListener(
    "finish",
    () => {
      resetPartAnimations(lineData);
    },
    { once: true }
  );
}

export function startLineAnimations(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number
): void {
  const appliedTimingOffsetMs = engine.learnedAnimationTimingOffsetMs;

  startLineAnimation(engine, lineData, config, currentTime, appliedTimingOffsetMs);
  if (lineData.lyricElement.dataset.instrumental === "true") {
    startInstrumentalAnimations(engine, lineData, config, currentTime, appliedTimingOffsetMs);
    return;
  }

  resolveLineGlowSuppression(engine, lineData, config);
  for (const part of lineData.parts) {
    startWordAnimations(engine, part, config, currentTime, appliedTimingOffsetMs);
  }
}

export function startLineExitAnimations(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig,
  currentTime: number
): void {
  // Read the entire line before cancelling any effects, so this does not alternate
  // per-word style reads with writes. There are no extra reads during normal ticks.
  const imagePaint = new Map<PartData, { target: HTMLElement; frame: Keyframe }[]>();
  for (const part of lineData.parts) {
    if (!part.imageLayers || currentTime < part.time) continue;
    const style = engine.window.getComputedStyle(part.imageLayers.glow);
    const paint = [
      { target: part.imageLayers.glow, frame: { opacity: style.opacity, filter: style.filter } as Keyframe },
    ];
    for (const target of part.letterElements ?? []) {
      paint.push({ target, frame: { transform: engine.window.getComputedStyle(target).transform } });
    }
    for (const target of [...(part.highlightLetterElements ?? []), ...part.imageLayers.glowLetters]) {
      const letterStyle = engine.window.getComputedStyle(target);
      paint.push({ target, frame: { maskPosition: letterStyle.maskPosition, transform: letterStyle.transform } });
    }
    imagePaint.set(part, paint);
  }
  startLineExitAnimation(lineData, config);

  if (lineData.lyricElement.dataset.instrumental === "true") {
    startInstrumentalExitAnimations(engine, lineData, config, currentTime);
    return;
  }

  for (const part of lineData.parts) {
    if (currentTime >= part.time) {
      startWordExitAnimation(part, config, imagePaint.get(part));
    } else {
      resetPartAnimations(part);
    }
  }
}

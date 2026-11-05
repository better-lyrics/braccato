import type { LineData, PartData } from "../inject";
import type { AnimationConfig } from "./animationConfig";
import { correctedAnimationTimeMs, trackLyricAnimationTiming } from "./animationTiming";
import { suppressInvisibleWordGlows } from "./glow";
import type { AnimationEngineInstance } from "./instance";
import { startInstrumentalAnimations, startInstrumentalExitAnimations } from "./instrumentalAnimations";
import { resetPartAnimations } from "./lineAnimationState";
import { type HeldPaint, startWordAnimations, startWordExitAnimation } from "./wordAnimations";

export function startLineAnimations(
  engine: AnimationEngineInstance,
  line: LineData,
  config: AnimationConfig,
  lyricTimeS: number
): void {
  const appliedTimingOffsetMs = engine.learnedAnimationTimingOffsetMs;
  startLineEntrance(engine, line, config, lyricTimeS, appliedTimingOffsetMs);
  if (isInstrumental(line)) {
    startInstrumentalAnimations(engine, line, config, lyricTimeS, appliedTimingOffsetMs);
    return;
  }
  suppressInvisibleWordGlows(engine, line, config);
  for (const part of line.parts) startWordAnimations(engine, part, config, lyricTimeS, appliedTimingOffsetMs);
}

export function startLineExitAnimations(
  engine: AnimationEngineInstance,
  line: LineData,
  config: AnimationConfig,
  lyricTimeS: number
): void {
  const heldPaint = readImagePaintBeforeWrites(engine, line, lyricTimeS);
  startLineExit(line, config);
  if (isInstrumental(line)) {
    startInstrumentalExitAnimations(line, config, lyricTimeS);
    return;
  }
  for (const part of line.parts) {
    if (lyricTimeS >= part.time) startWordExitAnimation(part, config, heldPaint.get(part));
    else resetPartAnimations(part);
  }
}

function isInstrumental(line: LineData): boolean {
  return line.lyricElement.dataset.instrumental === "true";
}

function startLineEntrance(
  engine: AnimationEngineInstance,
  line: LineData,
  config: AnimationConfig,
  lyricTimeS: number,
  appliedTimingOffsetMs: number
): void {
  resetPartAnimations(line);
  if (!config.enabled.lineScale) return;

  const { enterFrom, enterTo, enterEasing, durationMs } = config.line;
  const entrance = line.lyricElement.animate([{ transform: enterFrom }, { transform: enterTo }], {
    duration: durationMs,
    easing: enterEasing,
    fill: "forwards",
  });
  trackLyricAnimationTiming(engine, entrance, { appliedTimingOffsetMs, offsetMs: 0 });
  const elapsedMs = (lyricTimeS - line.time) * 1000;
  entrance.currentTime = correctedAnimationTimeMs(elapsedMs, appliedTimingOffsetMs, durationMs);
  line.animations = [entrance];
}

function startLineExit(line: LineData, config: AnimationConfig): void {
  resetPartAnimations(line);
  if (!config.enabled.lineScale) return;

  const { exitFrom, exitTo, exitEasing, durationMs } = config.line;
  const exit = line.lyricElement.animate([{ transform: exitFrom }, { transform: exitTo }], {
    duration: durationMs,
    easing: exitEasing,
    fill: "none",
  });
  line.animations = [exit];
  exit.addEventListener("finish", () => resetPartAnimations(line), { once: true });
}

function readImagePaintBeforeWrites(
  engine: AnimationEngineInstance,
  line: LineData,
  lyricTimeS: number
): Map<PartData, HeldPaint[]> {
  const heldPaint = new Map<PartData, HeldPaint[]>();
  const styleOf = (element: HTMLElement) => engine.window.getComputedStyle(element);
  for (const part of line.parts) {
    if (!part.imageLayers || lyricTimeS < part.time) continue;
    const glowStyle = styleOf(part.imageLayers.glow);
    const paint: HeldPaint[] = [
      { target: part.imageLayers.glow, frame: { opacity: glowStyle.opacity, filter: glowStyle.filter } as Keyframe },
    ];
    for (const target of part.letterElements ?? []) {
      paint.push({ target, frame: { transform: styleOf(target).transform } });
    }
    for (const target of [...(part.highlightLetterElements ?? []), ...part.imageLayers.glowLetters]) {
      const letterStyle = styleOf(target);
      paint.push({ target, frame: { maskPosition: letterStyle.maskPosition, transform: letterStyle.transform } });
    }
    heldPaint.set(part, paint);
  }
  return heldPaint;
}

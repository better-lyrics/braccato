import { toMs } from "../util";
import type { AnimationEngineInstance } from "./instance";
import { dropPendingLineScroll } from "./lineScroll";

export function clearStyleCaches(engine: AnimationEngineInstance): void {
  dropPendingLineScroll(engine);
  engine.cachedDurations.clear();
  engine.cachedCSSValues.clear();
  engine.cachedAnimationSettings = null;
  engine.cachedLineScrollTiming.clear();
}

export function getCSSValue(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: string
): string {
  let value = engine.cachedCSSValues.get(property);
  if (value === undefined) {
    value = engine.window.getComputedStyle(lyricsElement).getPropertyValue(property).trim() || fallback;
    engine.cachedCSSValues.set(property, value);
  }
  return value;
}

/**
 * Gets and caches a css duration.
 * The cache belongs to one engine instance, which resolves every lookup against its own lyrics
 * container, so this function does not key its cache on the element provided -- it assumes that
 * it isn't relevant to the calling code
 *
 * @param lyricsElement - the element to look up against
 * @param property - the css property to look up
 * @return - in ms
 */
export function getCSSDurationInMs(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string
): number {
  let duration = engine.cachedDurations.get(property);
  if (duration === undefined) {
    duration = toMs(getCSSValue(engine, lyricsElement, property, "0ms"));
    engine.cachedDurations.set(property, duration);
  }

  return duration;
}

export function getCSSDurationWithFallback(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: string
): number {
  return Math.max(toMs(getCSSValue(engine, lyricsElement, property, fallback)), 1);
}

export function getCSSNumber(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: number
): number {
  const value = Number.parseFloat(getCSSValue(engine, lyricsElement, property, `${fallback}`));
  return Number.isFinite(value) ? value : fallback;
}

export function getCSSBoolean(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: boolean
): boolean {
  const value = getCSSValue(engine, lyricsElement, property, fallback ? "1" : "0").toLowerCase();
  if (value === "false" || value === "off" || value === "none") return false;
  const numericValue = Number.parseFloat(value);
  if (Number.isFinite(numericValue)) return numericValue > 0;
  return fallback;
}

export function getCSSOffset(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: number
): number {
  return Math.max(0, Math.min(1, getCSSNumber(engine, lyricsElement, property, fallback)));
}

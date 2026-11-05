import { clamp, toMs } from "../util";
import type { AnimationEngineInstance } from "./instance";
import { dropPendingLineScroll } from "./lineScroll";

export interface ThemeReader {
  string(property: string, fallback: string): string;
  durationMs(property: string, fallback: string): number;
  number(property: string, fallback: number): number;
  fraction(property: string, fallback: number): number;
  flag(property: string, fallback: boolean): boolean;
}

export function clearStyleCaches(engine: AnimationEngineInstance): void {
  dropPendingLineScroll(engine);
  engine.cachedDurations.clear();
  engine.cachedCSSValues.clear();
  engine.cachedAnimationSettings = null;
  engine.cachedLineScrollTiming.clear();
}

// Property-only caching assumes every lookup for this engine uses its lyrics container.
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

export function getCSSNumber(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  property: string,
  fallback: number
): number {
  const value = Number.parseFloat(getCSSValue(engine, lyricsElement, property, `${fallback}`));
  return Number.isFinite(value) ? value : fallback;
}

export function createThemeReader(engine: AnimationEngineInstance, lyricsElement: HTMLElement): ThemeReader {
  const string = (property: string, fallback: string) => getCSSValue(engine, lyricsElement, property, fallback);
  const number = (property: string, fallback: number) => getCSSNumber(engine, lyricsElement, property, fallback);
  return {
    string,
    number,
    durationMs: (property, fallback) => Math.max(toMs(string(property, fallback)), 1),
    fraction: (property, fallback) => clamp(number(property, fallback), 0, 1),
    flag: (property, fallback) => {
      const value = string(property, fallback ? "1" : "0").toLowerCase();
      if (value === "false" || value === "off" || value === "none") return false;
      const numeric = Number.parseFloat(value);
      return Number.isFinite(numeric) ? numeric > 0 : fallback;
    },
  };
}

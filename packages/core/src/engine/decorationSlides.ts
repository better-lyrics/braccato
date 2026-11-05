import { ROMANIZED_LYRICS_CLASS, TRANSLATED_LYRICS_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { REDUCED_MOTION_QUERY } from "./motionPreference";

// -- Decoration slide --------------------------

const DECORATION_SLIDE_MS = 350;
const DECORATION_SLIDE_EASING = "cubic-bezier(0.25, 1, 0.5, 1)";
export const DECORATION_MIN_SHIFT_PX = 0.5;

export function slideElementBy(element: HTMLElement, dy: number): void {
  element.animate(
    { translate: [`0 ${dy}px`, "0 0"] },
    { duration: DECORATION_SLIDE_MS, easing: DECORATION_SLIDE_EASING, composite: "add" }
  );
}

export function decorationSlideAllowed(engine: AnimationEngineInstance, container: HTMLElement): boolean {
  if (engine.window.matchMedia(REDUCED_MOTION_QUERY).matches) return false;
  return (
    engine.window.getComputedStyle(container).getPropertyValue("--blyrics-animate-decoration-entry").trim() !== "0"
  );
}

export function lineDecorators(lineElement: HTMLElement): HTMLElement[] {
  return [
    ...lineElement.querySelectorAll<HTMLElement>(`.${ROMANIZED_LYRICS_CLASS}`),
    ...lineElement.querySelectorAll<HTMLElement>(`.${TRANSLATED_LYRICS_CLASS}`),
  ];
}

/**
 * Snapshots where the lines and their decorators sit now, so the remeasure that follows can slide
 * each one from there to wherever a streamed decoration just pushed it. Returns null when nothing
 * should animate, and otherwise a function to call once the new layout is measured: the line rides
 * its own shift and a decorator rides only the part of its shift its line did not already carry, so
 * a survivor whose line held still still slides into the gap a removed sibling left.
 */
export function captureDecorationSlide(engine: AnimationEngineInstance): (() => void) | null {
  const container = engine.lyricsContainer;
  if (!container || engine.layout === "stage" || !decorationSlideAllowed(engine, container)) return null;

  const before = engine.lines.map(line => ({
    line,
    position: line.position,
    decorations: new Map(line.decorations),
  }));

  return () => {
    for (const { line, position, decorations } of before) {
      const lineShift = position - line.position;
      if (Math.abs(lineShift) >= DECORATION_MIN_SHIFT_PX) slideElementBy(line.lyricElement, lineShift);

      for (const [element, was] of decorations) {
        const now = line.decorations.get(element);
        if (now === undefined) continue;
        const shift = was - now - lineShift;
        if (Math.abs(shift) >= DECORATION_MIN_SHIFT_PX) slideElementBy(element, shift);
      }
    }
  };
}

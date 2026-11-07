import { ROMANIZED_LYRICS_CLASS, TRANSLATED_LYRICS_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { REDUCED_MOTION_QUERY } from "./motionPreference";

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
        const ownShift = was - now - lineShift;
        if (Math.abs(ownShift) >= DECORATION_MIN_SHIFT_PX) slideElementBy(element, ownShift);
      }
    }
  };
}

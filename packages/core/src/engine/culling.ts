import type { AnimationEngineInstance } from "./instance";
import { isLineVisibleDuringScroll, LINE_SCROLL_WILL_CHANGE_VALUE, type LineScrollItem } from "./lineScroll";

export function clearVisibleLyricWillChange(engine: AnimationEngineInstance): void {
  for (const element of engine.visibleWillChangeElements) {
    element.style.removeProperty("will-change");
  }
  engine.visibleWillChangeElements = new Set();
}

// Near-viewport lines come from the intersection observer with one viewport of overscan, not from
// scrollTop, because a scaled/transformed scroll decouples layout coords from what is on screen.
const LINE_CULL_ROOT_MARGIN = "100% 0px 100% 0px";

function cullLine(element: HTMLElement): void {
  element.style.setProperty("content-visibility", "auto");
}

function uncullLine(element: HTMLElement): void {
  element.style.removeProperty("content-visibility");
}

export function clearOffscreenLineCulling(engine: AnimationEngineInstance): void {
  for (const element of engine.culledLineElements) {
    uncullLine(element);
  }
  engine.culledLineElements = new Set();
}

// Rebuilt rather than updated on every line change or relayout, so a skipped line's placeholder height
// is always freshly measured. Without IntersectionObserver every line stays rendered.
export function setupLineCullObserver(engine: AnimationEngineInstance): void {
  engine.lineCullObserver?.disconnect();
  clearOffscreenLineCulling(engine);
  if (engine.layout === "stage") {
    engine.lineCullObserver = null;
    return;
  }

  const ObserverConstructor = engine.window.IntersectionObserver;
  if (typeof ObserverConstructor !== "function" || engine.lines.length === 0) {
    engine.lineCullObserver = null;
    return;
  }

  // Scroll anchoring would compensate residual cull height-shifts with a scroll the engine misreads as the user's (Firefox); the engine owns scrollTop, so disable it.
  engine.host.getScrollElement()?.style.setProperty("overflow-anchor", "none");

  // Pin each line's skipped placeholder to its last rendered size, so skipping a line never shifts the
  // container's scroll height, which the engine would misread as a user scroll.
  const restingHeights = engine.lines.map(line => line.lyricElement.offsetHeight);
  engine.lines.forEach((line, index) => {
    line.lyricElement.style.setProperty("contain-intrinsic-block-size", `auto ${restingHeights[index]}px`);
  });

  const observer = new ObserverConstructor(
    entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting) {
          if (engine.culledLineElements.delete(element)) uncullLine(element);
        } else if (!engine.culledLineElements.has(element)) {
          cullLine(element);
          engine.culledLineElements.add(element);
        }
      }
    },
    { root: null, rootMargin: LINE_CULL_ROOT_MARGIN, threshold: 0 }
  );

  for (const line of engine.lines) {
    observer.observe(line.lyricElement);
  }
  engine.lineCullObserver = observer;
}

export function updateVisibleLyricWillChange(
  engine: AnimationEngineInstance,
  lines: LineScrollItem[],
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number
): void {
  const nextVisibleElements = new Set<HTMLElement>();

  for (const line of lines) {
    if (isLineVisibleDuringScroll(line, fromScrollTop, toScrollTop, viewportHeight)) {
      line.lyricElement.style.setProperty("will-change", LINE_SCROLL_WILL_CHANGE_VALUE);
      nextVisibleElements.add(line.lyricElement);
    }
  }

  for (const element of engine.visibleWillChangeElements) {
    if (!nextVisibleElements.has(element)) {
      element.style.removeProperty("will-change");
    }
  }

  engine.visibleWillChangeElements = nextVisibleElements;
}

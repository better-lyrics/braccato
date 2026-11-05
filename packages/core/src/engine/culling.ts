import type { AnimationEngineInstance } from "./instance";
import { isLineVisibleDuringScroll, LINE_SCROLL_WILL_CHANGE_VALUE, type LineScrollItem } from "./lineScroll";

// Use screen intersections because transformed scrolling decouples layout coordinates from visibility.
const ONE_VIEWPORT_OVERSCAN = "100% 0px 100% 0px";

export function setupLineCullObserver(engine: AnimationEngineInstance): void {
  engine.lineCullObserver?.disconnect();
  engine.lineCullObserver = null;
  clearOffscreenLineCulling(engine);
  const Observer = engine.window.IntersectionObserver;
  if (engine.layout === "stage" || typeof Observer !== "function" || engine.lines.length === 0) return;

  // The engine owns scrollTop; Firefox's scroll anchoring would answer cull height shifts with a scroll the
  // engine reads as the user's.
  engine.host.getScrollElement()?.style.setProperty("overflow-anchor", "none");
  pinCulledLineHeights(engine);

  const observer = new Observer(
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
    { root: null, rootMargin: ONE_VIEWPORT_OVERSCAN, threshold: 0 }
  );
  for (const line of engine.lines) observer.observe(line.lyricElement);
  engine.lineCullObserver = observer;
}

export function clearOffscreenLineCulling(engine: AnimationEngineInstance): void {
  for (const element of engine.culledLineElements) uncullLine(element);
  engine.culledLineElements = new Set();
}

function pinCulledLineHeights(engine: AnimationEngineInstance): void {
  const renderedHeights = engine.lines.map(line => line.lyricElement.offsetHeight);
  engine.lines.forEach((line, index) => {
    line.lyricElement.style.setProperty("contain-intrinsic-block-size", `auto ${renderedHeights[index]}px`);
  });
}

function cullLine(element: HTMLElement): void {
  element.style.setProperty("content-visibility", "auto");
}

function uncullLine(element: HTMLElement): void {
  element.style.removeProperty("content-visibility");
}

export function updateVisibleLyricWillChange(
  engine: AnimationEngineInstance,
  lines: LineScrollItem[],
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number
): void {
  const visibleElements = new Set<HTMLElement>();
  for (const line of lines) {
    if (!isLineVisibleDuringScroll(line, fromScrollTop, toScrollTop, viewportHeight)) continue;
    line.lyricElement.style.setProperty("will-change", LINE_SCROLL_WILL_CHANGE_VALUE);
    visibleElements.add(line.lyricElement);
  }
  for (const element of engine.visibleWillChangeElements) {
    if (!visibleElements.has(element)) element.style.removeProperty("will-change");
  }
  engine.visibleWillChangeElements = visibleElements;
}

export function clearVisibleLyricWillChange(engine: AnimationEngineInstance): void {
  for (const element of engine.visibleWillChangeElements) element.style.removeProperty("will-change");
  engine.visibleWillChangeElements = new Set();
}

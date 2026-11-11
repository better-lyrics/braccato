import type { LineData } from "../inject";
import { hasUnplacedContextSweeps } from "./contextSweep";
import { timelineNow } from "./elementMotion";
import type { AnimationEngineInstance } from "./instance";
import { resetLineAnimationState } from "./lineAnimationState";
import { isLineVisibleDuringScroll, LINE_SCROLL_WILL_CHANGE_VALUE, type LineScrollItem } from "./lineScroll";

// Measured positions, not an IntersectionObserver: an observer recomputes every line on every frame anything moves.
export interface LineCulling {
  scroller: HTMLElement;
  contentOffset: number;
  followReaderScroll: () => void;
  framesSinceSetup: number;
  lastFrameTime: number;
}

// A skipped line keeps the height it last rendered at, so none is skipped before a frame has rendered them all.
const FRAMES_BEFORE_SKIPPING = 2;

export function setupLineCulling(engine: AnimationEngineInstance): void {
  stopLineCulling(engine);
  const container = engine.lyricsContainer;
  if (engine.layout === "stage" || !container || engine.lines.length === 0) return;
  const scroller = engine.host.getScrollElement();
  if (!scroller) return;

  // The engine owns scrollTop; Firefox's scroll anchoring would answer cull height shifts with a scroll the
  // engine reads as the user's.
  scroller.style.setProperty("overflow-anchor", "none");
  pinCulledLineHeights(engine);

  const culling: LineCulling = {
    scroller,
    contentOffset: measureContentOffset(scroller, container),
    followReaderScroll: () => cullAroundScroller(engine, culling),
    framesSinceSetup: 0,
    lastFrameTime: timelineNow(engine),
  };
  engine.lineCulling = culling;
  scroller.addEventListener("scroll", culling.followReaderScroll, { passive: true });
  cullAroundScroller(engine, culling);
  for (const line of engine.lines) {
    if (!engine.culledLineElements.has(line.lyricElement)) restartUnplacedLine(line);
  }
}

export function stopLineCulling(engine: AnimationEngineInstance): void {
  const culling = engine.lineCulling;
  if (culling) culling.scroller.removeEventListener("scroll", culling.followReaderScroll);
  engine.lineCulling = null;
  clearOffscreenLineCulling(engine);
}

function cullAroundScroller(engine: AnimationEngineInstance, culling: LineCulling): void {
  if (!culling.scroller.isConnected) return;
  const scrollTop = culling.scroller.scrollTop;
  const viewportHeight = engine.cachedTabRendererHeight ?? culling.scroller.clientHeight;
  updateLineCulling(engine, scrollTop, engine.pendingLineScroll?.toScrollTop ?? scrollTop, viewportHeight);
}

// A line scroll's transforms stay between the two scroll positions; one viewport either side is the margin.
export function updateLineCulling(
  engine: AnimationEngineInstance,
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number
): void {
  const culling = engine.lineCulling;
  if (!culling || !hasRenderedSinceSetup(engine, culling)) return;
  const top = Math.min(fromScrollTop, toScrollTop) - viewportHeight - culling.contentOffset;
  const bottom = Math.max(fromScrollTop, toScrollTop) + 2 * viewportHeight - culling.contentOffset;
  for (const line of engine.lines) {
    const element = line.lyricElement;
    const rendered = !isMeasured(line) || (line.position + line.height >= top && line.position <= bottom);
    if (rendered) {
      if (!engine.culledLineElements.delete(element)) continue;
      uncullLine(element);
      restartUnplacedLine(line);
    } else if (!engine.culledLineElements.has(element)) {
      cullLine(element);
      engine.culledLineElements.add(element);
    }
  }
}

function hasRenderedSinceSetup(engine: AnimationEngineInstance, culling: LineCulling): boolean {
  if (culling.framesSinceSetup >= FRAMES_BEFORE_SKIPPING) return true;
  const frameTime = timelineNow(engine);
  if (frameTime !== culling.lastFrameTime) {
    culling.lastFrameTime = frameTime;
    culling.framesSinceSetup += 1;
  }
  return culling.framesSinceSetup >= FRAMES_BEFORE_SKIPPING;
}

function isMeasured(line: LineData): boolean {
  return line.position >= 0 && line.height >= 0;
}

function measureContentOffset(scroller: HTMLElement, container: HTMLElement): number {
  const scrollerTop = scroller.getBoundingClientRect().y + scroller.clientTop;
  return container.getBoundingClientRect().y - scrollerTop + scroller.scrollTop;
}

/** A line that started while it was skipped starts over now that its words have boxes to place on. */
function restartUnplacedLine(line: LineData): void {
  if (hasUnplacedContextSweeps(line)) resetLineAnimationState(line);
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

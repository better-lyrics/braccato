import type { LineData } from "../inject";
import type { LyricSyncType } from "../types";
import { ANIMATING_CLASS, CURRENT_LYRICS_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { currentTranslateY, replaceStageElements, resetStage } from "./stageMotion";
import { clearLineScrollAnimations, dropPendingLineScroll, removeLineScrollAnimation } from "./lineScroll";
import { clearOffscreenLineCulling, clearVisibleLyricWillChange } from "./culling";
import { resetLineAnimationState, togglePartClass } from "./lineAnimationState";
import { stopPassiveScrollLoop } from "./passiveScroll";
import { DECORATION_MIN_SHIFT_PX, decorationSlideAllowed, slideElementBy } from "./decorationSlides";

/**
 * Takes the lines this view is showing off the screen, keeping the container they were in, and
 * reports whether there was anything there to take.
 */
export function clearOnScreenLyrics(engine: AnimationEngineInstance): boolean {
  if (!engine.lyricsContainer) return false;
  engine.lyricsContainer.replaceChildren();
  resetStage(engine);
  return true;
}

export function hasRenderedLines(engine: AnimationEngineInstance): boolean {
  return engine.lines.length > 0;
}

/**
 * The render records this view built. Handing them out is a leak: they carry this view's elements
 * and its `Animation` objects, so a caller that rewrites line times or hangs translations off them
 * can only ever reach one view. Phase 5 revisits it, when both of those have to reach two.
 */
export function getRenderedLines(engine: AnimationEngineInstance): LineData[] {
  return engine.lines;
}

export function getRenderedSyncType(engine: AnimationEngineInstance): LyricSyncType {
  return engine.syncType;
}

/**
 * Drops the song this view was rendering: its selection, its pending scroll work, its animations
 * and its render records. The records go before the caller clears the DOM, so the elements they
 * hold are released along with it.
 */
export function clearLyrics(engine: AnimationEngineInstance): void {
  engine.scrollPos = -1;
  dropPendingLineScroll(engine);
  clearLineScrollAnimations(engine);
  clearVisibleLyricWillChange(engine);
  engine.lineCullObserver?.disconnect();
  engine.lineCullObserver = null;
  clearOffscreenLineCulling(engine);
  for (const line of engine.lines) {
    resetLineAnimationState(line);
    line.isSelected = false;
  }
  engine.skipScrollsDecayTimes = [];
  engine.lastScrollElements = [];
  engine.pinnedScrollLine = null;
  engine.lastScrollDebugContext.activeElms = [];
  engine.lastScrollDebugContext.centers = [];
  engine.passiveScrollAccumulatedTime = 0;
  engine.passiveLastWallTime = 0;
  stopPassiveScrollLoop(engine);
  engine.lines = [];
  engine.cachedFooterItem = null;
  engine.cachedCreditsItem = null;
  engine.creditsFocused = false;
  engine.lyricsContainer = null;
  engine.waveAnimationPool.length = 0;
  resetStage(engine);
}

/**
 * How far a scroll still running has carried a line from its place, or zero with none running on it.
 */
export function lineScrollOffset(engine: AnimationEngineInstance, element: HTMLElement): number {
  if (!engine.lineScrollAnimations.some(record => record.lineElement === element)) return 0;
  return currentTranslateY(engine, element, 0);
}

/**
 * Hands the engine the lines of a song swapped into the view it already holds. A kept line is the
 * same record and keeps everything; a dropped line's animations stop and nothing goes on holding it;
 * a line built in place of one is handed what the engine held for that one, so the scroll does not
 * see a line it has not met and the stage does not fade in a line that was already up.
 *
 * @param lines - The new song's records, kept ones included, in order
 * @param dropped - Records of the song before that the new one no longer has
 * @param replaced - Each new record built in place of a dropped one, to the one it replaced
 */
export function replaceRenderedLines(
  engine: AnimationEngineInstance,
  lines: LineData[],
  dropped: readonly LineData[],
  replaced: ReadonlyMap<LineData, LineData>
): void {
  const successors = new Map<LineData, LineData>();
  for (const [line, previous] of replaced) successors.set(previous, line);
  const droppedElements = new Set(dropped.map(line => line.lyricElement));
  const carry = (line: LineData): LineData | null =>
    successors.get(line) ?? (droppedElements.has(line.lyricElement) ? null : line);
  const carryAll = (from: readonly LineData[]): LineData[] =>
    from.map(carry).filter((line): line is LineData => line !== null);

  // The line being sung is still the line being sung, so a theme keyed on those classes does not dim it
  // and bring it back. Its animations are set up again from the new timing on the next tick. Read
  // before the dropped lines are let go, which clears their selection.
  for (const [line, previous] of replaced) {
    line.isScrolled = previous.isScrolled;
    line.isSelected = previous.isSelected;
    togglePartClass(line, CURRENT_LYRICS_CLASS, previous.lyricElement.classList.contains(CURRENT_LYRICS_CLASS));
    togglePartClass(line, ANIMATING_CLASS, previous.lyricElement.classList.contains(ANIMATING_CLASS));
  }

  // A planned scroll was planned against lines and places this swap is about to change.
  dropPendingLineScroll(engine);
  for (const record of [...engine.lineScrollAnimations]) {
    if (!droppedElements.has(record.lineElement)) continue;
    record.animation.cancel();
    removeLineScrollAnimation(engine, record);
  }
  for (const line of dropped) {
    resetLineAnimationState(line);
    line.isSelected = false;
    engine.visibleWillChangeElements.delete(line.lyricElement);
    engine.culledLineElements.delete(line.lyricElement);
  }

  engine.lastScrollElements = carryAll(engine.lastScrollElements);
  engine.lastScrollDebugContext.activeElms = carryAll(engine.lastScrollDebugContext.activeElms);
  engine.pinnedScrollLine = engine.pinnedScrollLine === null ? null : carry(engine.pinnedScrollLine);
  engine.lines = lines;

  if (engine.layout === "stage") replaceStageElements(engine, dropped, replaced);
}

/**
 * Carries a swapped view across the layout change it caused. The line the reader is following holds
 * still on screen: the scroll moves by however far that line moved in the container. Every other
 * line that moved, relative to it, slides from where it was rather than jumping.
 *
 * Which line is followed depends on who owns the scroll. While the engine does, it is the line the
 * last scroll aimed at; while the reader does, it is the first line they could see.
 *
 * @param before - Where each line was in the container before the swap and how tall, from `swapLyrics`
 * @param scrollTopBefore - The scroll position the swap began at
 */
export function settleSwappedLines(
  engine: AnimationEngineInstance,
  before: ReadonlyMap<LineData, { position: number; height: number; offset: number }>,
  scrollTopBefore: number
): void {
  const container = engine.lyricsContainer;
  const scrollElement = engine.host.getScrollElement();
  if (container === null || scrollElement === null || engine.layout === "stage") return;

  const readerOwnsScroll = engine.scrollResumeTime > Date.now();
  const followed = readerOwnsScroll
    ? engine.lines.find(line => {
        const was = before.get(line);
        return was !== undefined && was.position + was.height > scrollTopBefore;
      })
    : (engine.lastScrollElements.findLast(line => before.has(line)) ??
      engine.lines.find(line => before.has(line) && line.isScrolled));

  const followedWas = followed === undefined ? undefined : before.get(followed)?.position;
  // A line that has not been measured, because the view is not on screen, has nowhere to hold still.
  if (followed !== undefined && followedWas !== undefined && followedWas >= 0 && followed.position >= 0) {
    const moved = followed.position - followedWas;
    if (Math.abs(moved) >= DECORATION_MIN_SHIFT_PX) scrollElement.scrollTop = scrollTopBefore + moved;
  }
  // Read back rather than assumed: the browser may have clamped the write, or clamped the scroll for
  // a song that got shorter before anything here wrote it. Either way the event that follows is not
  // the reader's, and a write the browser clamped to nothing sends none.
  const shift = scrollElement.scrollTop - scrollTopBefore;
  if (shift !== 0) {
    engine.skipScrolls += 1;
    engine.skipScrollsDecayTimes.push(Date.now() + 2000);
    if (engine.scrollPos >= 0) engine.scrollPos += shift;
  }

  if (!decorationSlideAllowed(engine, container)) return;
  for (const line of engine.lines) {
    const was = before.get(line);
    if (was === undefined || was.position < 0 || line.position < 0) continue;
    // From where it is on screen, which a line scroll still running carries away from its place.
    const onScreenShift = was.position + was.offset - line.position + shift;
    if (Math.abs(onScreenShift) >= DECORATION_MIN_SHIFT_PX) slideElementBy(line.lyricElement, onScreenShift);
  }
}

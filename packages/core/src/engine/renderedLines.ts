import { ANIMATING_CLASS, CURRENT_LYRICS_CLASS } from "../constants";
import type { LineData } from "../inject";
import type { LyricSyncType } from "../types";
import { clearVisibleLyricWillChange, stopLineCulling } from "./culling";
import { DECORATION_MIN_SHIFT_PX, decorationSlideAllowed, slideElementBy } from "./decorationSlides";
import { stopAllElementMotion, stopElementMotion } from "./elementMotion";
import type { AnimationEngineInstance } from "./instance";
import { resetLineAnimationState, togglePartClass } from "./lineAnimationState";
import { dropPendingLineScroll } from "./lineScroll";
import { stopPassiveScrollLoop } from "./passiveScroll";
import { replaceStageElements, resetStage } from "./stageMotion";
import { noteEngineScrollEvent } from "./userScroll";

type LinePlacement = { position: number; height: number; motionOffset: number };

export function clearOnScreenLyrics(engine: AnimationEngineInstance): boolean {
  if (!engine.lyricsContainer) return false;
  engine.lyricsContainer.replaceChildren();
  resetStage(engine);
  return true;
}

export function hasRenderedLines(engine: AnimationEngineInstance): boolean {
  return engine.lines.length > 0;
}

export function getRenderedLines(engine: AnimationEngineInstance): LineData[] {
  return engine.lines;
}

export function getRenderedSyncType(engine: AnimationEngineInstance): LyricSyncType {
  return engine.syncType;
}

export function clearLyrics(engine: AnimationEngineInstance): void {
  engine.scrollPos = -1;
  dropPendingLineScroll(engine);
  stopAllElementMotion(engine);
  clearVisibleLyricWillChange(engine);
  stopLineCulling(engine);
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
  engine.passiveScrollTop = null;
  stopPassiveScrollLoop(engine);
  engine.lines = [];
  engine.cachedFooterItem = null;
  engine.cachedCreditsItem = null;
  engine.creditsFocused = false;
  engine.lyricsContainer = null;
  engine.waveAnimationPool.length = 0;
  resetStage(engine);
}

export function replaceRenderedLines(
  engine: AnimationEngineInstance,
  lines: LineData[],
  dropped: readonly LineData[],
  previousOf: ReadonlyMap<LineData, LineData>
): void {
  for (const [line, previous] of previousOf) carrySelection(line, previous);

  dropPendingLineScroll(engine);
  const droppedElements = new Set(dropped.map(line => line.lyricElement));
  for (const element of droppedElements) stopElementMotion(engine, element);
  for (const line of dropped) {
    resetLineAnimationState(line);
    line.isSelected = false;
    engine.visibleWillChangeElements.delete(line.lyricElement);
    engine.culledLineElements.delete(line.lyricElement);
  }

  const successorOf = new Map<LineData, LineData>();
  for (const [line, previous] of previousOf) successorOf.set(previous, line);
  const carry = (line: LineData): LineData | null =>
    successorOf.get(line) ?? (droppedElements.has(line.lyricElement) ? null : line);
  const carryAll = (from: readonly LineData[]): LineData[] =>
    from.map(carry).filter((line): line is LineData => line !== null);
  engine.lastScrollElements = carryAll(engine.lastScrollElements);
  engine.lastScrollDebugContext.activeElms = carryAll(engine.lastScrollDebugContext.activeElms);
  engine.pinnedScrollLine = engine.pinnedScrollLine === null ? null : carry(engine.pinnedScrollLine);
  engine.lines = lines;

  if (engine.layout === "stage") replaceStageElements(engine, dropped, previousOf);
}

function carrySelection(line: LineData, previous: LineData): void {
  line.isScrolled = previous.isScrolled;
  line.isSelected = previous.isSelected;
  togglePartClass(line, CURRENT_LYRICS_CLASS, previous.lyricElement.classList.contains(CURRENT_LYRICS_CLASS));
  togglePartClass(line, ANIMATING_CLASS, previous.lyricElement.classList.contains(ANIMATING_CLASS));
}

export function settleSwappedLines(
  engine: AnimationEngineInstance,
  before: ReadonlyMap<LineData, LinePlacement>,
  scrollTopBefore: number
): void {
  const container = engine.lyricsContainer;
  const scroller = engine.host.getScrollElement();
  if (container === null || scroller === null || engine.layout === "stage") return;

  const now = Date.now();
  const followed = followedLine(engine, before, scrollTopBefore, now);
  const followedWas = followed === undefined ? undefined : before.get(followed)?.position;
  if (followed !== undefined && followedWas !== undefined && isMeasured(followedWas) && isMeasured(followed.position)) {
    const moved = followed.position - followedWas;
    if (Math.abs(moved) >= DECORATION_MIN_SHIFT_PX) scroller.scrollTop = scrollTopBefore + moved;
  }
  // Layout or this write may clamp scrolling; count an engine scroll event only when the actual position changed.
  const appliedShift = scroller.scrollTop - scrollTopBefore;
  if (appliedShift !== 0) {
    noteEngineScrollEvent(engine, now);
    if (engine.scrollPos >= 0) engine.scrollPos += appliedShift;
  }

  if (!decorationSlideAllowed(engine, container)) return;
  for (const line of engine.lines) {
    const was = before.get(line);
    if (was === undefined || !isMeasured(was.position) || !isMeasured(line.position)) continue;
    const onScreenShift = was.position + was.motionOffset - line.position + appliedShift;
    if (Math.abs(onScreenShift) >= DECORATION_MIN_SHIFT_PX) slideElementBy(engine, line.lyricElement, onScreenShift);
  }
}

function followedLine(
  engine: AnimationEngineInstance,
  before: ReadonlyMap<LineData, LinePlacement>,
  scrollTopBefore: number,
  now: number
): LineData | undefined {
  const readerOwnsScroll = engine.scrollResumeTime > now;
  if (readerOwnsScroll) {
    return engine.lines.find(line => {
      const was = before.get(line);
      return was !== undefined && was.position + was.height > scrollTopBefore;
    });
  }
  return (
    engine.lastScrollElements.findLast(line => before.has(line)) ??
    engine.lines.find(line => before.has(line) && line.isScrolled)
  );
}

function isMeasured(position: number): boolean {
  return position >= 0;
}

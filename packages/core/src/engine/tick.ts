import { CREDITS_CLASS, CURRENT_LYRICS_CLASS, FOOTER_CLASS } from "../constants";
import type { LineData } from "../inject";
import type { ResolvedTickOptions, TickOptions } from "../types";
import { getRelativeLayoutBounds } from "../util";
import { getAnimationSettings } from "./animationConfig";
import { applyPlaybackRateToRunningAnimations, correctedScrollTimeS } from "./animationTiming";
import { followFocusedLines, lastSungLine, type ScrollerReading } from "./autoScroll";
import { advancePlaybackClock, lyricClockShiftS, NO_PLAYER_SNAPSHOT, type Playhead, playbackClock } from "./clock";
import { getCSSDurationInMs } from "./cssValues";
import {
  clearOffscreenLineCulling,
  clearVisibleLyricWillChange,
  setupLineCullObserver,
  updateVisibleLyricWillChange,
} from "./culling";
import { captureDecorationSlide, lineDecorators } from "./decorationSlides";
import type { AnimationEngineInstance } from "./instance";
import { driveLineAnimations } from "./lineLifecycle";
import { clearLineScrollAnimations, dropPendingLineScroll, measureTrailingItem } from "./lineScroll";
import {
  hasNoLyricsPlaceholder,
  hasUnsyncedLyrics,
  startPassiveScrollLoop,
  stopPassiveScrollLoop,
} from "./passiveScroll";
import { applyScrollPadding, measureScrollViewport, setupTabRendererObserver } from "./scrollViewport";
import { applyStage, measureStage } from "./stageMotion";
import { requestRescroll } from "./userScroll";

const NO_LYRICS_ELEMENT_LOG = "No lyrics element found on the page, skipping lyrics injection";
const TICK_ERROR_LOG = "Error in lyrics tick:";

/**
 * "lyrics-missing" means this instance has nothing left to render. Whether that ends ticking is the
 * driver's call, not the instance's: one instance running dry must not silence another.
 */
export type AnimationTickStatus = "ok" | "lyrics-missing";

export function resolveTickOptions(options: TickOptions): ResolvedTickOptions {
  return {
    isPlaying: options.isPlaying,
    eventCreationTime: options.eventCreationTime ?? NO_PLAYER_SNAPSHOT,
    smoothScroll: options.smoothScroll ?? true,
    globalLyricOffset: options.globalLyricOffset ?? 0,
    lyricOffset: options.lyricOffset ?? 0,
    richsyncOffsetTrim: options.richsyncOffsetTrim ?? 0,
    lineOffsetTrim: options.lineOffsetTrim ?? 0,
    passiveScrollEnabled: options.passiveScrollEnabled ?? false,
    playbackRate: usablePlaybackRate(options.playbackRate),
    followPausedSeeks: options.followPausedSeeks ?? false,
    countEveryUserScroll: options.countEveryUserScroll ?? false,
  };
}

function usablePlaybackRate(rate: number | undefined): number {
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : 1;
}

export function tickView(
  engine: AnimationEngineInstance,
  reportedTimeS: number,
  options: ResolvedTickOptions
): AnimationTickStatus {
  rememberTickOptions(engine, options);
  if (reportedTimeS === 0 && !options.isPlaying) return "ok";

  if (hasNoLyricsPlaceholder(engine)) {
    stopPassiveScrollLoop(engine);
    return "ok";
  }
  if (hasUnsyncedLyrics(engine)) {
    followUnsyncedLyrics(engine, options);
    return "ok";
  }

  const now = Date.now();
  const playhead = advancePlaybackClock(reportedTimeS, options, engine.playbackRate, now);
  if (playhead.jumped) dropPendingLineScroll(engine);

  if (!engine.host.isViewVisible()) {
    clearVisibleLyricWillChange(engine);
    return "ok";
  }
  if (engine.host.syncAdState()) return "ok";

  const lyricsElement = engine.lyricsContainer;
  if (!lyricsElement) {
    engine.host.log(NO_LYRICS_ELEMENT_LOG);
    return "lyrics-missing";
  }

  try {
    renderSyncedLyrics(engine, lyricsElement, playhead, options, now);
  } catch (error) {
    if (!isUndefinedAccessError(error)) engine.host.log(TICK_ERROR_LOG, error);
  }
  return "ok";
}

function rememberTickOptions(engine: AnimationEngineInstance, options: ResolvedTickOptions): void {
  engine.lastTickOptions = options;
  engine.passiveScrollEnabled = options.passiveScrollEnabled;
  if (engine.playbackRate === options.playbackRate) return;
  engine.playbackRate = options.playbackRate;
  applyPlaybackRateToRunningAnimations(engine);
}

function followUnsyncedLyrics(
  engine: AnimationEngineInstance,
  { isPlaying, passiveScrollEnabled }: ResolvedTickOptions
) {
  if (engine.layout === "stage") return;
  if (isPlaying && !playbackClock.lastPlayState) engine.scrollResumeTime = 0;
  playbackClock.lastPlayState = isPlaying;
  if (passiveScrollEnabled) startPassiveScrollLoop(engine);
}

function isUndefinedAccessError(error: unknown): boolean {
  return (error as Error).message?.includes("undefined") ?? false;
}

function renderSyncedLyrics(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  playhead: Playhead,
  options: ResolvedTickOptions,
  now: number
): void {
  const lyricTimeS = playhead.timeS + lyricClockShiftS(engine, lyricsElement, options);
  const scrollTimeS =
    correctedScrollTimeS(engine, lyricTimeS) +
    getCSSDurationInMs(engine, lyricsElement, "--blyrics-scroll-timing-offset") / 1000;
  const { config, scrollTiming } = getAnimationSettings(engine, lyricsElement);

  const isStage = engine.layout === "stage";
  const scroller = isStage ? null : readScrollerBeforeWrites(engine);
  if (!isStage && !scroller) {
    clearVisibleLyricWillChange(engine);
    return;
  }
  if (scroller && config.enabled.scroll) {
    const pendingScrollTop = engine.pendingLineScroll?.toScrollTop ?? scroller.scrollTop;
    updateVisibleLyricWillChange(engine, engine.lines, scroller.scrollTop, pendingScrollTop, scroller.height);
  } else {
    stopLineScrolling(engine);
  }

  const focus = focusLines(engine, scrollTimeS, scrollTiming.earlyScrollConsiderS);
  driveLineAnimations({ engine, lyricTimeS, playhead, config, now });
  const creditsFocusChanged = updateCreditsFocus(engine, lyricsElement, scrollTimeS);

  if (!scroller) {
    applyStage(engine, lyricTimeS, playhead.jumped);
    return;
  }
  followFocusedLines({
    engine,
    lyricsElement,
    scroller,
    focusedLines: focus.lines,
    scrollTimeS,
    config,
    smoothScroll: options.smoothScroll,
    countEveryUserScroll: options.countEveryUserScroll,
    jumped: playhead.jumped,
    focusChanged: playhead.jumped || focus.reachedUncommittedLine || creditsFocusChanged,
    now,
  });
}

function readScrollerBeforeWrites(engine: AnimationEngineInstance): ScrollerReading | null {
  const element = engine.host.getScrollElement();
  if (!element) return null;
  if (element !== engine.observedTabRenderer) setupTabRendererObserver(engine, element);
  return {
    element,
    height: engine.cachedTabRendererHeight ?? element.getBoundingClientRect().height,
    scrollTop: element.scrollTop,
    maxScrollTop: Math.max(0, element.scrollHeight - element.clientHeight),
  };
}

function stopLineScrolling(engine: AnimationEngineInstance): void {
  dropPendingLineScroll(engine);
  clearVisibleLyricWillChange(engine);
  clearLineScrollAnimations(engine);
}

function focusLines(
  engine: AnimationEngineInstance,
  scrollTimeS: number,
  earlyScrollConsiderS: number
): { lines: LineData[]; reachedUncommittedLine: boolean } {
  const lines = engine.lines;
  const focused: LineData[] = [];
  let reachedUncommittedLine = false;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const nextLineStartS = lines[index + 1]?.time ?? Infinity;
    const inFocus =
      scrollTimeS >= line.time - earlyScrollConsiderS &&
      (scrollTimeS < nextLineStartS || scrollTimeS < line.time + line.duration);
    setLineCurrent(line, inFocus);
    if (!inFocus) continue;
    focused.push(line);
    engine.selectedElementIndex = index;
    if (scrollTimeS >= line.time && !engine.lastScrollElements.includes(line)) reachedUncommittedLine = true;
  }
  return { lines: focused, reachedUncommittedLine };
}

function setLineCurrent(line: LineData, current: boolean): void {
  if (line.isScrolled === current) return;
  line.isScrolled = current;
  line.lyricElement.classList.toggle(CURRENT_LYRICS_CLASS, current);
}

function updateCreditsFocus(engine: AnimationEngineInstance, lyricsElement: HTMLElement, scrollTimeS: number): boolean {
  const lastLine = lastSungLine(engine);
  const focused =
    lastLine !== undefined &&
    (engine.cachedCreditsItem?.height ?? 0) > 0 &&
    scrollTimeS >= lastLine.time + lastLine.duration;
  if (focused === engine.creditsFocused) return false;
  engine.creditsFocused = focused;
  if (focused) lyricsElement.dataset.creditsFocused = "true";
  else delete lyricsElement.dataset.creditsFocused;
  return true;
}

export function relayout(engine: AnimationEngineInstance, linesAreRendered: boolean): void {
  if (engine.layout === "stage") {
    if (!linesAreRendered || !engine.lyricsContainer) return;
    engine.cachedCreditsItem = measureTrailingItem(engine.lyricsContainer, CREDITS_CLASS);
    measureStage(engine);
    return;
  }
  applyScrollPadding(engine);
  const scrollElement = engine.host.getScrollElement();
  if (scrollElement) measureScrollViewport(engine, scrollElement);
  if (!linesAreRendered) return;

  const lyricsElement = engine.lyricsContainer;
  if (!lyricsElement) return;
  engine.lyricWidth = lyricsElement.clientWidth;
  engine.lyricHeight = lyricsElement.clientHeight;
  measureLinePositions(engine, lyricsElement);
  engine.cachedCreditsItem = measureTrailingItem(lyricsElement, CREDITS_CLASS);
  engine.cachedFooterItem = measureTrailingItem(lyricsElement, FOOTER_CLASS);
  setupLineCullObserver(engine);

  requestRescroll(engine);
  engine.host.debug?.resize();
}

function measureLinePositions(engine: AnimationEngineInstance, lyricsElement: HTMLElement): void {
  clearOffscreenLineCulling(engine);
  for (const line of engine.lines) {
    const bounds = getRelativeLayoutBounds(lyricsElement, line.lyricElement);
    line.position = bounds.y;
    line.height = bounds.height;
    line.decorations = new Map(
      lineDecorators(line.lyricElement).map(element => [element, getRelativeLayoutBounds(lyricsElement, element).y])
    );
  }
}

export function cancelLyricPositionUpdate(engine: AnimationEngineInstance): void {
  if (engine.pendingLyricsUpdateFrame === null) return;
  engine.window.cancelAnimationFrame(engine.pendingLyricsUpdateFrame);
  engine.pendingLyricsUpdateFrame = null;
}

export function retickFromPlaybackClock(
  engine: AnimationEngineInstance,
  buildTickOptions: (eventCreationTime: number, isPlaying: boolean) => TickOptions
): AnimationTickStatus {
  const options = buildTickOptions(playbackClock.lastEventCreationTime, playbackClock.lastPlayState);
  return tickView(engine, playbackClock.lastTime, resolveTickOptions(options));
}

export function scheduleLyricPositionUpdate(
  engine: AnimationEngineInstance,
  isViewRendering: () => boolean,
  retick: () => void
): void {
  if (engine.pendingLyricsUpdateFrame !== null) return;
  dropPendingLineScroll(engine);
  engine.pendingLyricsUpdateFrame = engine.window.requestAnimationFrame(() => {
    engine.pendingLyricsUpdateFrame = null;
    const isRendering = isViewRendering();
    const playSlide = isRendering ? captureDecorationSlide(engine) : null;
    relayout(engine, isRendering);
    playSlide?.();
    if (isRendering) retick();
  });
}

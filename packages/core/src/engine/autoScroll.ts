import { USER_SCROLLING_CLASS } from "../constants";
import type { LineData } from "../inject";
import { registerThemeSetting } from "../themeSettings";
import { clamp } from "../util";
import type { AnimationConfig } from "./animationConfig";
import { updateVisibleLyricWillChange } from "./culling";
import { drawScrollDebugOverlay, isDebugOverlayEnabled } from "./debugOverlay";
import type { AnimationEngineInstance } from "./instance";
import {
  commitOrPrepareLineScroll,
  dropPendingLineScroll,
  getLineScrollItems,
  type LineScrollRequest,
  prepareUpcomingLineScroll,
  SCROLL_PREPARE_LEAD_MS,
} from "./lineScroll";
import { computeActiveLinesScrollTop, findScrollAnchor, getTargetScrollRatio } from "./scrollViewport";
import { decaySkipScrolls, writeEngineScrollTop } from "./userScroll";

const LYRIC_ENDING_THRESHOLD_S = registerThemeSetting("blyrics-lyric-ending-threshold-s", 0.5);
const SCROLL_DEADBAND_PX = 2;

export interface ScrollerReading {
  element: HTMLElement;
  height: number;
  scrollTop: number;
  maxScrollTop: number;
}

export interface AutoScrollTick {
  engine: AnimationEngineInstance;
  lyricsElement: HTMLElement;
  scroller: ScrollerReading;
  focusedLines: LineData[];
  scrollTimeS: number;
  config: AnimationConfig;
  smoothScroll: boolean;
  jumped: boolean;
  focusChanged: boolean;
  now: number;
}

export function followFocusedLines(tick: AutoScrollTick): void {
  const { engine, lyricsElement, now } = tick;
  if (isAutoScrolling(engine, now)) scrollToFocusedLines(tick);
  if (engine.wasUserScrolling && engine.scrollResumeTime < now) {
    engine.host.setResumeAffordanceVisible(false);
    lyricsElement.classList.remove(USER_SCROLLING_CLASS);
    engine.wasUserScrolling = false;
  }
  decaySkipScrolls(engine, now);
}

function isAutoScrolling(engine: AnimationEngineInstance, now: number): boolean {
  return engine.scrollResumeTime < now || engine.scrollPos === -1;
}

export function lastSungLine(engine: AnimationEngineInstance): LineData | undefined {
  return engine.lines.findLast(line => line.lyricElement.dataset.instrumental !== "true");
}

function scrollToFocusedLines(tick: AutoScrollTick): void {
  const { engine, lyricsElement, scroller, scrollTimeS, config, smoothScroll, jumped } = tick;
  const followedLines = tick.focusedLines.length > 0 ? tick.focusedLines : engine.lines.slice(0, 1);
  const leadLine = followedLines.at(-1);
  if (!leadLine) return;

  const targetOffset = scroller.height * getTargetScrollRatio(engine, lyricsElement);
  const endingThresholdS = LYRIC_ENDING_THRESHOLD_S.getNumberValue();
  const sungLines = followedLines.filter(
    line => line === leadLine || scrollTimeS < line.time + line.duration - endingThresholdS
  );
  const lineCenters = sungLines.map(line => line.position + line.height / 2);
  const anchor = findScrollAnchor(sungLines, scrollTimeS);
  const target = computeActiveLinesScrollTop(
    sungLines,
    anchor,
    scroller.height,
    engine.cachedScrollInsets,
    targetOffset
  );
  const toScrollTop = clamp(creditsAwareScrollTop(engine, target.scrollTop, targetOffset), 0, scroller.maxScrollTop);

  if (isDebugOverlayEnabled()) {
    drawScrollDebugOverlay(engine, {
      lyricsElement,
      scrollTop: scroller.scrollTop,
      viewportHeight: scroller.height,
      targetOffset,
      followedLines,
      lineCenters,
      scrollTimeS,
      endingThresholdS,
    });
  }

  const pinned = engine.pinnedScrollLine;
  const pinnedLineFinished =
    pinned !== null &&
    pinned !== anchor &&
    (!sungLines.includes(pinned) || scrollTimeS >= pinned.time + pinned.duration);
  const mustCommit = tick.focusChanged || pinnedLineFinished || engine.wasUserScrolling;

  const fromScrollTop = scroller.scrollTop;
  const moves = Math.abs(toScrollTop - fromScrollTop) > SCROLL_DEADBAND_PX;
  const animatesScroll = smoothScroll && config.enabled.scroll;
  const request = (): LineScrollRequest => ({
    lines: getLineScrollItems(engine, engine.lines),
    activeLine: leadLine,
    fromScrollTop,
    toScrollTop,
    viewportHeight: scroller.height,
    config,
    continuesEngineScroll:
      !jumped &&
      !engine.wasUserScrolling &&
      engine.scrollPos >= 0 &&
      Math.abs(fromScrollTop - engine.scrollPos) <= SCROLL_DEADBAND_PX,
  });

  const msUntilLeadLine = (leadLine.time - scrollTimeS) * 1000;
  const leadLineIsNext = msUntilLeadLine > 0 && msUntilLeadLine <= SCROLL_PREPARE_LEAD_MS;
  if (animatesScroll && moves && !mustCommit && leadLineIsNext && !engine.lastScrollElements.includes(leadLine)) {
    updateVisibleLyricWillChange(engine, engine.lines, fromScrollTop, toScrollTop, scroller.height);
    prepareUpcomingLineScroll(engine, request());
  }

  if (!mustCommit) return;
  engine.lastScrollElements = followedLines;
  engine.pinnedScrollLine = target.overflowsBand ? anchor : null;
  engine.lastScrollDebugContext = { lyricScrollTime: scrollTimeS, centers: lineCenters, activeElms: followedLines };

  if (smoothScroll && moves) {
    if (config.enabled.scroll) {
      updateVisibleLyricWillChange(engine, engine.lines, fromScrollTop, toScrollTop, scroller.height);
      commitOrPrepareLineScroll(engine, request());
    }
  } else {
    dropPendingLineScroll(engine);
  }
  writeEngineScrollTop(engine, scroller.element, toScrollTop, tick.now);
}

function creditsAwareScrollTop(engine: AnimationEngineInstance, scrollTop: number, targetOffset: number): number {
  const credits = engine.cachedCreditsItem;
  const lastLine = lastSungLine(engine);
  if (!engine.creditsFocused || !credits || !lastLine) return scrollTop;
  const creditsCentered = credits.position + credits.height / 2 - targetOffset;
  const lastLineAtTop = lastLine.position - engine.cachedScrollInsets.top;
  return Math.min(creditsCentered, lastLineAtTop);
}

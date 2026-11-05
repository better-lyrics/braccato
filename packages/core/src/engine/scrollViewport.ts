import { registerThemeSetting } from "../themeSettings";
import { CREDITS_CLASS, FOOTER_CLASS, LINE_CLASS } from "../constants";
import { getRelativeLayoutBounds } from "../util";
import type { AnimationEngineInstance } from "./instance";
import { getCSSValue } from "./cssValues";
import { dropPendingLineScroll } from "./lineScroll";
import { hasNoLyricsPlaceholder } from "./passiveScroll";

// 0.5 means the selected lyric will be in the middle of the screen, 0 means top, 1 means bottom
const SCROLL_POS_OFFSET_RATIO = registerThemeSetting("blyrics-target-scroll-pos-ratio", 0.37);

// The comment setting is shared by every view in a bundle; the custom property lets a theme scope it to one.
export function getTargetScrollRatio(engine: AnimationEngineInstance, lyricsElement: HTMLElement): number {
  const scoped = Number.parseFloat(getCSSValue(engine, lyricsElement, "--blyrics-target-scroll-pos-ratio", ""));
  return Number.isFinite(scoped) ? Math.max(0, Math.min(1, scoped)) : SCROLL_POS_OFFSET_RATIO.getNumberValue();
}

/**
 * Sets up a ResizeObserver on the tab renderer to cache its height.
 * Avoids calling getBoundingClientRect() every tick which causes layout thrashing.
 */
export function setupTabRendererObserver(engine: AnimationEngineInstance, element: HTMLElement) {
  if (engine.tabRendererResizeObserver) {
    engine.tabRendererResizeObserver.disconnect();
  }

  engine.tabRendererResizeObserver = new engine.window.ResizeObserver(() => {
    dropPendingLineScroll(engine);
    if (element && element.isConnected) {
      measureScrollViewport(engine, element);
    }
  });

  engine.tabRendererResizeObserver.observe(element);
  engine.observedTabRenderer = element;
  measureScrollViewport(engine, element);
}

// -- Visible scroll band --------------------------

export interface ScrollInsets {
  readonly top: number;
  readonly bottom: number;
}

export const NO_SCROLL_INSETS: ScrollInsets = { top: 0, bottom: 0 };

function resolveScrollInset(value: string, viewportHeight: number): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return value.trim().endsWith("%") ? (viewportHeight * amount) / 100 : amount;
}

/**
 * The scroll element's `scroll-padding` is the part of its viewport a host has declared unreadable,
 * such as an edge faded out by a mask. Insets that leave no band at all are ignored rather than
 * obeyed, since there would be nowhere left to put a line.
 */
export function resolveScrollInsets(
  scrollPaddingTop: string,
  scrollPaddingBottom: string,
  viewportHeight: number
): ScrollInsets {
  const top = resolveScrollInset(scrollPaddingTop, viewportHeight);
  const bottom = resolveScrollInset(scrollPaddingBottom, viewportHeight);
  return top + bottom < viewportHeight ? { top, bottom } : NO_SCROLL_INSETS;
}

export function measureScrollViewport(engine: AnimationEngineInstance, element: HTMLElement): void {
  const height = element.getBoundingClientRect().height;
  const { scrollPaddingTop, scrollPaddingBottom } = engine.window.getComputedStyle(element);
  engine.cachedTabRendererHeight = height;
  engine.cachedScrollInsets = resolveScrollInsets(scrollPaddingTop, scrollPaddingBottom, height);
}

interface ScrollTargetLine {
  readonly time: number;
  readonly duration: number;
  readonly position: number;
  readonly height: number;
}

/**
 * The line the singer is on: the latest one still being sung. An earlier line still running is a
 * tail, such as a background echo or a held note, and a later one is still in its lookahead. A line
 * stays active past its own end until the next one starts, so a started line only wins while it runs.
 */
export function findScrollAnchor<Line extends ScrollTargetLine>(sungLines: readonly Line[], scrollTime: number): Line {
  return (
    sungLines.findLast(line => line.time <= scrollTime && scrollTime < line.time + line.duration) ??
    sungLines.findLast(line => line.time <= scrollTime) ??
    sungLines[0]
  );
}

/**
 * Where to scroll so the lines being sung sit around the target, inside the visible band. When they
 * do not all fit, the anchor keeps its top in view and the rest give way. `overflowsBand` tells the
 * caller the view is pinned to the anchor, and has to move on once that line ends.
 *
 * @param sungLines - In order, never empty. The last is the last active line.
 */
export function computeActiveLinesScrollTop(
  sungLines: readonly ScrollTargetLine[],
  anchor: ScrollTargetLine,
  viewportHeight: number,
  insets: ScrollInsets,
  targetOffset: number
): { scrollTop: number; overflowsBand: boolean } {
  const first = sungLines[0];
  const last = sungLines[sungLines.length - 1];
  const averageCentre =
    sungLines.reduce((total, line) => total + line.position + line.height / 2, 0) / sungLines.length;
  const visibleBottom = viewportHeight - insets.bottom;

  let scrollTop = averageCentre - targetOffset;
  scrollTop = Math.max(scrollTop, last.position + last.height - visibleBottom);
  scrollTop = Math.min(scrollTop, last.position - insets.top);
  scrollTop = Math.min(scrollTop, first.position - insets.top);
  scrollTop = Math.max(scrollTop, anchor.position + anchor.height - visibleBottom);
  scrollTop = Math.min(scrollTop, anchor.position - insets.top);
  return {
    scrollTop,
    overflowsBand: last.position + last.height - first.position > visibleBottom - insets.top,
  };
}

// -- Layout --------------------------

/**
 * What a view has to know to size its scroll padding. Split out from the element reads so the
 * arithmetic can be checked against the degenerate cases, which is where it went wrong: an
 * unrendered container answers zero to every measurement.
 */
interface ScrollPaddingMeasurements {
  viewportHeight: number;
  targetScrollRatio: number;
  /** The container's own height with whatever bottom padding it currently carries taken back off. */
  contentHeight: number;
  firstLineHeight: number;
  /** Distance from the top of the container to the middle of the last line, or null with no lines. */
  lastLineCentre: number | null;
  lastLineHeight: number;
  footerHeight: number;
}

/**
 * Sizes the padding above the first line and below the last one so either can sit at the view's
 * target scroll position.
 *
 * The first two candidates are exact, and both are measured from the container. They are worth
 * nothing while it is not rendering: every line reports zero, which reads as content that already
 * runs past the last line and asks for no padding at all, and the last lines of the song then have
 * nowhere to scroll to. The viewport keeps its height whether the lyrics render or not, so the
 * space it alone demands below the last line is always knowable, and it is the floor. Over-padding
 * costs nothing visible; under-padding strands the end of every song.
 */
export function computeScrollPadding(measurements: ScrollPaddingMeasurements): { top: number; bottom: number } {
  const { viewportHeight, targetScrollRatio, contentHeight, lastLineCentre } = measurements;

  const top = Math.max(0, viewportHeight * targetScrollRatio - measurements.firstLineHeight / 2);

  const lastLineTargetContentHeight =
    lastLineCentre === null ? viewportHeight : lastLineCentre + viewportHeight * (1 - targetScrollRatio);

  const trailingContentHeight = measurements.footerHeight + measurements.lastLineHeight / 2;
  const viewportTailSpace = viewportHeight * (1 - targetScrollRatio) - trailingContentHeight;

  const bottom = Math.max(
    lastLineTargetContentHeight - contentHeight,
    viewportHeight - contentHeight,
    viewportTailSpace,
    0
  );

  return { top, bottom: Math.ceil(bottom) };
}

/**
 * Sizes the padding this view needs and writes it where the stylesheet reads it, which is the
 * document's root element. That makes it the second thing a view writes per document rather than
 * per view, alongside the theme's `<style>`, so it is the same one renderer per document constraint
 * the README states under Theme settings and not a new one: a second renderer in this document
 * overwrites these two properties with the padding its own viewport needs, and the first view is
 * then padded for a viewport it is not in.
 *
 * The root rather than the container because these are published names. Both readers in this repo
 * select `.blyrics-container`, but the extension's own `mobile.css` is one of them, from outside
 * the module, and a theme is free to read them anywhere: narrowing where they resolve would break
 * such a theme silently, the way any custom property that stops resolving does. That is a real cost
 * against a corruption the module already forbids.
 */
export function applyScrollPadding(engine: AnimationEngineInstance): void {
  const lyricsElement = engine.lyricsContainer;
  const tabRenderer = engine.host.getScrollElement();
  if (!lyricsElement || !tabRenderer) return;

  if (hasNoLyricsPlaceholder(engine)) {
    setScrollPadding(engine, lyricsElement, { top: 0, bottom: 0 });
    return;
  }

  const tabRendererHeight = tabRenderer.getBoundingClientRect().height;
  const scrollPosOffsetRatio = getTargetScrollRatio(engine, lyricsElement);
  const currentPaddingBottom = Number.parseFloat(engine.window.getComputedStyle(lyricsElement).paddingBottom) || 0;
  const lyricsHeightWithoutBottomPadding = Math.max(0, lyricsElement.scrollHeight - currentPaddingBottom);

  const lyricLines = lyricsElement.querySelectorAll<HTMLElement>(`:scope > .${LINE_CLASS}`);
  const firstLyric = lyricLines[0] ?? null;
  const lastLyric = lyricLines[lyricLines.length - 1] ?? null;
  const credits = lyricsElement.querySelector<HTMLElement>(`:scope > .${CREDITS_CLASS}`);
  const creditsBounds = credits ? getRelativeLayoutBounds(lyricsElement, credits) : null;
  // The credits take the focus once the song ends, so they are the last thing the scroll must reach.
  const lastLyricBounds =
    creditsBounds && creditsBounds.height > 0
      ? creditsBounds
      : lastLyric
        ? getRelativeLayoutBounds(lyricsElement, lastLyric)
        : null;
  const footer = lyricsElement.querySelector<HTMLElement>(`:scope > .${FOOTER_CLASS}`);

  const { top, bottom } = computeScrollPadding({
    viewportHeight: tabRendererHeight,
    targetScrollRatio: scrollPosOffsetRatio,
    contentHeight: lyricsHeightWithoutBottomPadding,
    firstLineHeight: firstLyric ? getRelativeLayoutBounds(lyricsElement, firstLyric).height : 0,
    lastLineCentre: lastLyricBounds ? lastLyricBounds.y + lastLyricBounds.height / 2 : null,
    lastLineHeight: lastLyricBounds?.height ?? 0,
    footerHeight: footer ? getRelativeLayoutBounds(lyricsElement, footer).height : 0,
  });

  setScrollPadding(engine, lyricsElement, { top, bottom });
}

function setScrollPadding(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  { top, bottom }: { top: number; bottom: number }
): void {
  engine.document.documentElement.style.setProperty("--blyrics-padding-top", top + "px");
  engine.document.documentElement.style.setProperty("--blyrics-padding-bottom", bottom + "px");
  // Inline, because a theme's own `.blyrics-container { padding }` is appended after the package's
  // stylesheet at the same weight and would otherwise take this room away.
  lyricsElement.style.setProperty("padding-bottom", bottom + "px");
}

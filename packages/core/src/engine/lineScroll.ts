import { registerThemeSetting } from "../themeSettings";
import type { LineData } from "../inject";
import { getRelativeLayoutBounds, toMs } from "../util";
import type { AnimationEngineInstance } from "./instance";
import type { AnimationConfig } from "./animationConfig";

export const SCROLL_PREPARE_LEAD_MS = 120;
const LINE_SCROLL_FALLBACK_DURATION_MS = 750;

function registerLineScrollStyleSetting(property: string, defaultValue: string) {
  return [property, registerThemeSetting(property.slice(2), defaultValue)] as const;
}

const LINE_SCROLL_AFTER_FUNCTION =
  "calc(750ms + log(var(--blyrics-line-scroll-abs-relative-index) + 2, 2.71828) * 80ms + (var(--blyrics-line-scroll-abs-relative-index) + 1) * 20ms)";

const LINE_SCROLL_STYLE_SETTINGS = [
  registerLineScrollStyleSetting("--blyrics-line-scroll-duration", LINE_SCROLL_AFTER_FUNCTION),
  registerLineScrollStyleSetting(
    "--blyrics-line-scroll-above-duration",
    "calc(750ms + min(var(--blyrics-line-scroll-abs-relative-index), 6) * 20ms)"
  ),
  registerLineScrollStyleSetting("--blyrics-line-scroll-active-duration", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-below-duration", LINE_SCROLL_AFTER_FUNCTION),
  registerLineScrollStyleSetting(
    "--blyrics-line-scroll-timing-function",
    "var(--blyrics-lyric-scroll-timing-function)"
  ),
  registerLineScrollStyleSetting("--blyrics-line-scroll-start-easing", "var(--blyrics-line-scroll-timing-function)"),
  registerLineScrollStyleSetting("--blyrics-line-scroll-end-easing", "linear"),
  registerLineScrollStyleSetting("--blyrics-line-scroll-above-start-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-active-start-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-below-start-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-above-end-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-active-end-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-below-end-easing", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-translate-y-start", "var(--blyrics-line-scroll-delta-px)"),
  registerLineScrollStyleSetting("--blyrics-line-scroll-translate-y-end", "0px"),
  registerLineScrollStyleSetting("--blyrics-line-scroll-above-translate-y-start", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-active-translate-y-start", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-below-translate-y-start", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-above-translate-y-end", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-active-translate-y-end", ""),
  registerLineScrollStyleSetting("--blyrics-line-scroll-below-translate-y-end", ""),
] as const;

// Tracked so the tick can skip the per-line translate write-then-read unless a theme overrides it.
const LINE_SCROLL_TRANSLATE_SETTINGS = LINE_SCROLL_STYLE_SETTINGS.filter(([property]) =>
  property.includes("translate-y")
).map(([, setting]) => setting);
type LineScrollSide = "above" | "active" | "below";
type LineScrollKeyframe = "start" | "end";
export interface LineScrollItem {
  lyricElement: HTMLElement;
  height: number;
  position: number;
}
export interface LineScrollAnimationRecord {
  animation: Animation;
  lineElement: HTMLElement;
  token: number;
}
const LINE_SCROLL_INDEX_PROPERTY = "--blyrics-line-scroll-index";
const LINE_SCROLL_ACTIVE_INDEX_PROPERTY = "--blyrics-line-scroll-active-index";
const LINE_SCROLL_RELATIVE_INDEX_PROPERTY = "--blyrics-line-scroll-relative-index";
const LINE_SCROLL_ABS_RELATIVE_INDEX_PROPERTY = "--blyrics-line-scroll-abs-relative-index";
const LINE_SCROLL_SIDE_PROPERTY = "--blyrics-line-scroll-side";
const LINE_SCROLL_DELTA_PROPERTY = "--blyrics-line-scroll-delta-px";
const LINE_SCROLL_DISTANCE_PROPERTY = "--blyrics-line-scroll-distance-px";
export const LINE_SCROLL_WILL_CHANGE_VALUE = "transform, translate";
const LINE_SCROLL_INLINE_PROPERTIES = [
  LINE_SCROLL_INDEX_PROPERTY,
  LINE_SCROLL_ACTIVE_INDEX_PROPERTY,
  LINE_SCROLL_RELATIVE_INDEX_PROPERTY,
  LINE_SCROLL_ABS_RELATIVE_INDEX_PROPERTY,
  LINE_SCROLL_SIDE_PROPERTY,
  LINE_SCROLL_DELTA_PROPERTY,
  LINE_SCROLL_DISTANCE_PROPERTY,
  ...LINE_SCROLL_STYLE_SETTINGS.map(([property]) => property),
];

export function clearLineScrollAnimations(engine: AnimationEngineInstance): void {
  const records = engine.lineScrollAnimations;
  engine.lineScrollAnimations = [];
  for (const record of records) {
    record.animation.cancel();
    clearLineScrollInlineProperties(engine, record.lineElement, record.token);
  }
}

export function removeLineScrollAnimation(engine: AnimationEngineInstance, record: LineScrollAnimationRecord): void {
  const index = engine.lineScrollAnimations.indexOf(record);
  if (index !== -1) {
    engine.lineScrollAnimations.splice(index, 1);
  }
  clearLineScrollInlineProperties(engine, record.lineElement, record.token);
}

function trackLineScrollAnimation(
  engine: AnimationEngineInstance,
  animation: Animation,
  lineElement: HTMLElement,
  token: number
): void {
  const record: LineScrollAnimationRecord = { animation, lineElement, token };
  engine.lineScrollAnimations.push(record);

  animation.addEventListener("finish", () => removeLineScrollAnimation(engine, record), { once: true });
  animation.addEventListener("cancel", () => removeLineScrollAnimation(engine, record), { once: true });
}

function lineScrollSide(relativeIndex: number, scrollDeltaPx: number): LineScrollSide {
  const isScrollingUp = scrollDeltaPx < 0;
  if (relativeIndex < 0) return isScrollingUp ? "below" : "above";
  if (relativeIndex > 0) return isScrollingUp ? "above" : "below";
  return "active";
}

function setLineScrollSettingProperty(
  lineElement: HTMLElement,
  property: string,
  setting: ReturnType<typeof registerThemeSetting>
): void {
  const value = setting.getStringValue().trim();
  if (value) {
    lineElement.style.setProperty(property, value);
  } else {
    lineElement.style.removeProperty(property);
  }
}

function setLineScrollStyleProperties(lineElement: HTMLElement): void {
  for (const [property, setting] of LINE_SCROLL_STYLE_SETTINGS) {
    setLineScrollSettingProperty(lineElement, property, setting);
  }
}

function lineScrollTranslate(side: LineScrollSide, state: LineScrollKeyframe, useDifferentialEffects: boolean): string {
  const sideProperty = `--blyrics-line-scroll-${side}-translate-y-${state}`;
  const sharedProperty = `--blyrics-line-scroll-translate-y-${state}`;
  const fallback = state === "start" ? "var(--blyrics-line-scroll-delta-px, 0px)" : "0px";

  if (useDifferentialEffects) {
    return `0 var(${sideProperty}, var(${sharedProperty}, ${fallback}))`;
  }

  return `0 var(${sharedProperty}, ${fallback})`;
}

function normalizedTranslate(translateValue: string): string {
  const translate = translateValue.trim();
  return translate && translate !== "none" ? translate : "0px 0px";
}

function restoreInlineStyleProperty(
  lineElement: HTMLElement,
  property: string,
  previousValue: string,
  previousPriority: string
): void {
  if (previousValue) {
    lineElement.style.setProperty(property, previousValue, previousPriority);
  } else {
    lineElement.style.removeProperty(property);
  }
}

function lineScrollDurationProperty(side: LineScrollSide, fallbackMs: number, useDifferentialEffects: boolean): string {
  return useDifferentialEffects
    ? `var(--blyrics-line-scroll-${side}-duration, var(--blyrics-line-scroll-duration, ${fallbackMs}ms))`
    : `var(--blyrics-line-scroll-duration, ${fallbackMs}ms)`;
}

function clearLineScrollInlineProperties(
  engine: AnimationEngineInstance,
  lineElement: HTMLElement,
  token?: number
): void {
  if (token !== undefined && engine.lineScrollElementTokens.get(lineElement) !== token) {
    return;
  }

  for (const property of LINE_SCROLL_INLINE_PROPERTIES) {
    lineElement.style.removeProperty(property);
  }
  engine.lineScrollElementTokens.delete(lineElement);
}

function lineScrollEasingProperty(
  side: LineScrollSide,
  keyframe: LineScrollKeyframe,
  fallback: string,
  useDifferentialEffects: boolean
): string {
  return useDifferentialEffects
    ? `var(--blyrics-line-scroll-${side}-${keyframe}-easing, var(--blyrics-line-scroll-${keyframe}-easing, var(--blyrics-line-scroll-timing-function, ${fallback})))`
    : `var(--blyrics-line-scroll-${keyframe}-easing, var(--blyrics-line-scroll-timing-function, ${fallback}))`;
}

interface PreparedLineScroll {
  lineElement: HTMLElement;
  side: LineScrollSide;
  token: number;
}

interface ResolvedLineScroll extends PreparedLineScroll {
  durationMs: number;
  startEasing: string;
  endEasing: string;
  startTranslate: string;
  endTranslate: string;
}

// Memoised per (side, |relativeIndex|) because the scroll duration and easings depend only on those,
// not on the pixel delta.
export interface LineScrollTiming {
  durationMs: number;
  startEasing: string;
  endEasing: string;
}

interface LineScrollPlan {
  items: ResolvedLineScroll[];
}

export interface PendingLineScroll {
  plan: LineScrollPlan;
  activeLineElement: HTMLElement;
  fromScrollTop: number;
  toScrollTop: number;
}

/**
 * Resolves one temporary computed-style probe for every visible line. Keeping
 * each property in its own write/read/restore phase preserves the original
 * resolver semantics while reducing N style flushes to one flush per probe.
 */
function batchResolveLineScrollProperty<T>(
  engine: AnimationEngineInstance,
  items: PreparedLineScroll[],
  property: string,
  probeValue: (item: PreparedLineScroll) => string,
  readValue: (style: CSSStyleDeclaration) => T
): T[] {
  const previous = items.map(item => ({
    value: item.lineElement.style.getPropertyValue(property),
    priority: item.lineElement.style.getPropertyPriority(property),
  }));

  for (const item of items) {
    item.lineElement.style.setProperty(property, probeValue(item), "important");
  }

  const values = items.map(item => readValue(engine.window.getComputedStyle(item.lineElement)));

  for (let index = 0; index < items.length; index++) {
    restoreInlineStyleProperty(items[index].lineElement, property, previous[index].value, previous[index].priority);
  }

  return values;
}

export function isLineVisibleDuringScroll(
  lineData: LineScrollItem,
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number
): boolean {
  const visibleTop = Math.min(fromScrollTop, toScrollTop);
  const visibleBottom = Math.max(fromScrollTop + viewportHeight, toScrollTop + viewportHeight);
  const lineTop = lineData.position;
  const lineBottom = lineData.position + lineData.height;
  return lineBottom >= visibleTop && lineTop <= visibleBottom;
}

// The credits and the footer after the last line scroll with the lines. Their bounds come from the
// relayout-time cache, not a getBoundingClientRect here, which would force a synchronous recalc
// mid-tick after the scroll commit dirtied style.
export function getLineScrollItems(engine: AnimationEngineInstance, lines: LineData[]): LineScrollItem[] {
  const trailing = [engine.cachedCreditsItem, engine.cachedFooterItem].filter(item => item !== null);
  return trailing.length > 0 ? [...lines, ...trailing] : lines;
}

export function measureTrailingItem(lyricsElement: HTMLElement, className: string): LineScrollItem | null {
  const element = lyricsElement.querySelector<HTMLElement>(`:scope > .${className}`);
  if (!element) return null;
  const bounds = getRelativeLayoutBounds(lyricsElement, element);
  return { lyricElement: element, position: bounds.y, height: bounds.height };
}

// A leading line slower than the one behind closes their gap by distance times progress difference.
function lineScrollStaggerScale(
  lines: LineScrollItem[],
  activeLineIndex: number,
  scrollDistancePx: number,
  naturalAdvance: boolean
): number {
  if (naturalAdvance) return 1;
  const active = lines[activeLineIndex];
  const steps = [lines[activeLineIndex - 1], lines[activeLineIndex + 1]]
    .filter(neighbour => neighbour !== undefined)
    .map(neighbour => Math.abs(active.position - neighbour.position));
  const stepPx = steps.length > 0 ? Math.min(...steps) : active.height;
  return Math.min(1, stepPx / scrollDistancePx);
}

function prepareLineScrollOffsets(
  engine: AnimationEngineInstance,
  lines: LineScrollItem[],
  activeLineIndex: number,
  scrollDeltaPx: number,
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number,
  config: AnimationConfig,
  naturalAdvance: boolean
): LineScrollPlan | null {
  if (!config.enabled.scroll || activeLineIndex < 0) {
    return null;
  }

  const scrollDistancePx = Math.abs(scrollDeltaPx);
  const translateThemed = LINE_SCROLL_TRANSLATE_SETTINGS.some(setting => setting.isManuallySet());
  const defaultStartTranslate = `0px ${scrollDeltaPx}px`;

  // Preserve the original windowing exactly: only lines intersecting the
  // union of the old and new viewports receive scroll animations.
  const requests: {
    item: PreparedLineScroll;
    index: number;
    relativeIndex: number;
    timingKey: string;
    timing: LineScrollTiming | undefined;
  }[] = [];
  for (let index = 0; index < lines.length; index++) {
    if (!isLineVisibleDuringScroll(lines[index], fromScrollTop, toScrollTop, viewportHeight)) {
      continue;
    }
    const lineElement = lines[index].lyricElement;
    const relativeIndex = index - activeLineIndex;
    const side = lineScrollSide(relativeIndex, scrollDeltaPx);
    const token = ++engine.lineScrollAnimationToken;
    engine.lineScrollElementTokens.set(lineElement, token);
    const item: PreparedLineScroll = { lineElement, side, token };
    const timingKey = `${side}|${Math.abs(relativeIndex)}`;
    requests.push({ item, index, relativeIndex, timingKey, timing: engine.cachedLineScrollTiming.get(timingKey) });
  }

  // The line-scroll vars reach the DOM only for an uncached line, or every line when a theme drives the
  // translate off them, so an otherwise-cached scroll leaves the visible lines untouched.
  const linesToWrite = requests.filter(request => translateThemed || !request.timing);
  for (const { item, index, relativeIndex } of linesToWrite) {
    const lineElement = item.lineElement;
    lineElement.style.setProperty(LINE_SCROLL_INDEX_PROPERTY, String(index));
    lineElement.style.setProperty(LINE_SCROLL_ACTIVE_INDEX_PROPERTY, String(activeLineIndex));
    lineElement.style.setProperty(LINE_SCROLL_RELATIVE_INDEX_PROPERTY, String(relativeIndex));
    lineElement.style.setProperty(LINE_SCROLL_ABS_RELATIVE_INDEX_PROPERTY, String(Math.abs(relativeIndex)));
    lineElement.style.setProperty(LINE_SCROLL_SIDE_PROPERTY, item.side);
    lineElement.style.setProperty(LINE_SCROLL_DELTA_PROPERTY, `${scrollDeltaPx}px`);
    lineElement.style.setProperty(LINE_SCROLL_DISTANCE_PROPERTY, `${scrollDistancePx}px`);
    setLineScrollStyleProperties(lineElement);
  }

  const misses = requests.filter(request => !request.timing);
  if (misses.length > 0) {
    const missItems = misses.map(request => request.item);
    const durations = batchResolveLineScrollProperty(
      engine,
      missItems,
      "transition-duration",
      item =>
        lineScrollDurationProperty(item.side, LINE_SCROLL_FALLBACK_DURATION_MS, config.lineScroll.differentialEffects),
      style => {
        const durationMs = toMs(style.transitionDuration.split(",")[0].trim());
        return durationMs > 0 ? durationMs : LINE_SCROLL_FALLBACK_DURATION_MS;
      }
    );
    const startEasings = batchResolveLineScrollProperty(
      engine,
      missItems,
      "transition-timing-function",
      item =>
        lineScrollEasingProperty(item.side, "start", config.lineScroll.easing, config.lineScroll.differentialEffects),
      style => style.transitionTimingFunction.trim() || config.lineScroll.easing
    );
    const endEasings = batchResolveLineScrollProperty(
      engine,
      missItems,
      "transition-timing-function",
      item =>
        lineScrollEasingProperty(item.side, "end", config.lineScroll.easing, config.lineScroll.differentialEffects),
      style => style.transitionTimingFunction.trim() || config.lineScroll.easing
    );
    misses.forEach((request, resolveIndex) => {
      const timing: LineScrollTiming = {
        durationMs: durations[resolveIndex],
        startEasing: startEasings[resolveIndex],
        endEasing: endEasings[resolveIndex],
      };
      engine.cachedLineScrollTiming.set(request.timingKey, timing);
      request.timing = timing;
    });
  }

  let startTranslates: string[] | null = null;
  let endTranslates: string[] | null = null;
  if (translateThemed) {
    const items = requests.map(request => request.item);
    startTranslates = batchResolveLineScrollProperty(
      engine,
      items,
      "translate",
      item => lineScrollTranslate(item.side, "start", config.lineScroll.differentialEffects),
      style => normalizedTranslate(style.translate)
    );
    endTranslates = batchResolveLineScrollProperty(
      engine,
      items,
      "translate",
      item => lineScrollTranslate(item.side, "end", config.lineScroll.differentialEffects),
      style => normalizedTranslate(style.translate)
    );
  }

  const staggerScale = lineScrollStaggerScale(lines, activeLineIndex, scrollDistancePx, naturalAdvance);
  const activeDurationMs = requests.find(request => request.relativeIndex === 0)?.timing?.durationMs;

  return {
    items: requests.map((request, requestIndex) => {
      const timing = request.timing as LineScrollTiming;
      return {
        ...request.item,
        durationMs:
          activeDurationMs === undefined
            ? timing.durationMs
            : activeDurationMs + (timing.durationMs - activeDurationMs) * staggerScale,
        startEasing: timing.startEasing,
        endEasing: timing.endEasing,
        startTranslate: startTranslates ? startTranslates[requestIndex] : defaultStartTranslate,
        endTranslate: endTranslates ? endTranslates[requestIndex] : "0px 0px",
      };
    }),
  };
}

function startPreparedLineScroll(engine: AnimationEngineInstance, plan: LineScrollPlan): void {
  for (const item of plan.items) {
    if (!item.lineElement.isConnected || engine.lineScrollElementTokens.get(item.lineElement) !== item.token) continue;

    const animation = item.lineElement.animate(
      [
        { translate: item.startTranslate, easing: item.startEasing },
        { translate: item.endTranslate, easing: item.endEasing },
      ] as Keyframe[],
      {
        composite: "add",
        duration: item.durationMs,
        easing: "linear",
        fill: "none",
      }
    );

    trackLineScrollAnimation(engine, animation, item.lineElement, item.token);
  }
}

function discardLineScrollPlan(engine: AnimationEngineInstance, plan: LineScrollPlan): void {
  for (const item of plan.items) {
    clearLineScrollInlineProperties(engine, item.lineElement, item.token);
  }
}

export function dropPendingLineScroll(engine: AnimationEngineInstance): void {
  if (!engine.pendingLineScroll) return;
  discardLineScrollPlan(engine, engine.pendingLineScroll.plan);
  engine.pendingLineScroll = null;
}

function pendingLineScrollMatches(
  engine: AnimationEngineInstance,
  activeLine: LineData,
  fromScrollTop: number,
  toScrollTop: number
): boolean {
  return !!(
    engine.pendingLineScroll &&
    engine.pendingLineScroll.activeLineElement === activeLine.lyricElement &&
    Math.abs(engine.pendingLineScroll.fromScrollTop - fromScrollTop) <= 2 &&
    Math.abs(engine.pendingLineScroll.toScrollTop - toScrollTop) <= 2
  );
}

export function commitOrPrepareLineScroll(
  engine: AnimationEngineInstance,
  lines: LineScrollItem[],
  activeLine: LineData,
  scrollDeltaPx: number,
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number,
  config: AnimationConfig,
  naturalAdvance: boolean
): void {
  if (pendingLineScrollMatches(engine, activeLine, fromScrollTop, toScrollTop)) {
    const pending = engine.pendingLineScroll!;
    engine.pendingLineScroll = null;
    startPreparedLineScroll(engine, pending.plan);
    return;
  }

  dropPendingLineScroll(engine);
  const plan = prepareLineScrollOffsets(
    engine,
    lines,
    lines.findIndex(line => line.lyricElement === activeLine.lyricElement),
    scrollDeltaPx,
    fromScrollTop,
    toScrollTop,
    viewportHeight,
    config,
    naturalAdvance
  );
  if (plan) startPreparedLineScroll(engine, plan);
}

export function prepareUpcomingLineScroll(
  engine: AnimationEngineInstance,
  lines: LineScrollItem[],
  activeLine: LineData,
  scrollDeltaPx: number,
  fromScrollTop: number,
  toScrollTop: number,
  viewportHeight: number,
  config: AnimationConfig,
  naturalAdvance: boolean
): void {
  if (pendingLineScrollMatches(engine, activeLine, fromScrollTop, toScrollTop)) return;

  dropPendingLineScroll(engine);
  const activeLineIndex = lines.findIndex(line => line.lyricElement === activeLine.lyricElement);
  const plan = prepareLineScrollOffsets(
    engine,
    lines,
    activeLineIndex,
    scrollDeltaPx,
    fromScrollTop,
    toScrollTop,
    viewportHeight,
    config,
    naturalAdvance
  );
  if (plan) {
    engine.pendingLineScroll = {
      plan,
      activeLineElement: activeLine.lyricElement,
      fromScrollTop,
      toScrollTop,
    };
  }
}

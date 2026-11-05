// The animation engine: one instance per rendered view, holding that view's lines, its selection,
// its scroll state and the per frame work that keeps the three in step. `renderer.ts` is what a
// consumer holds; this is what it is holding.
//
// An instance per rendered surface rather than a singleton, because this extension runs two: the
// YouTube Music side panel and the floating window. The two share parsed lyric data and a playback
// clock and nothing else, so anything one view can disagree with another about lives on the
// instance.
//
// The module owns no clock. A tick arrives from outside with the time already on it, which here is
// the interpolated player snapshot behind `blyrics-send-player-time`, and in the floating window a
// second interpolation of that same snapshot. Neither is a media element, which is why the custom
// element can own an animation frame loop over one while nothing under here owns a loop at all.
//
// Two things are module scope rather than instance scope: the set of live instances, and the
// playback clock the last tick wrote. Their unit is a bundle rather than a document, and this
// module is bundled into the isolated world and the page world separately, so those are two clocks
// that never meet. `themeSettings.ts` holds the third thing under that rule.

import type { LineData } from "../inject";
import type { LyricsLayout, LyricsRendererHost, LyricSyncType, ResolvedTickOptions } from "../types";
import type { StageBox, StageMetrics } from "../stage";
import { NO_SCROLL_INSETS, type ScrollInsets } from "./scrollViewport";
import type { LineScrollAnimationRecord, LineScrollItem, LineScrollTiming, PendingLineScroll } from "./lineScroll";
import type { AnimationSettings } from "./animationConfig";
import { REDUCED_MOTION_QUERY } from "./motionPreference";
import { clearStyleCaches } from "./cssValues";
import { liveEngines } from "./liveViews";
import { stopPassiveScrollLoop } from "./passiveScroll";
import { cancelLyricPositionUpdate } from "./tick";

// -- Engine instance --------------------------

/**
 * Everything that belongs to a single rendered lyrics view: one scroll container, one selection,
 * one set of pending scroll work.
 */
interface AnimEngineViewState {
  /**
   * The render records this view built, one per lyric line. They hold this view's elements and
   * this view's `Animation` objects, so a second view never shares them.
   */
  lines: LineData[];
  lyricsContainer: HTMLElement | null;
  syncType: LyricSyncType;
  lyricWidth: number;
  lyricHeight: number;
  skipScrolls: number;
  skipScrollsDecayTimes: number[];
  scrollResumeTime: number;
  scrollPos: number;
  selectedElementIndex: number;
  wasUserScrolling: boolean;
  lastScrollElements: LineData[];
  /** The line a committed scroll kept in view because the active lines overflowed the band. */
  pinnedScrollLine: LineData | null;
  lastScrollDebugContext: {
    activeElms: LineData[];
    centers: number[];
    lyricScrollTime: number;
  };
  passiveScrollAccumulatedTime: number;
  passiveLastWallTime: number;
}

/**
 * `Window` alone types neither `ResizeObserver` nor `DOMMatrix`: both are ambient `var`
 * declarations, so they only appear through `typeof globalThis`.
 */
type EngineWindow = Window & typeof globalThis;

export interface AnimationEngineInstance extends AnimEngineViewState {
  document: Document;
  window: EngineWindow;
  host: LyricsRendererHost;
  cachedTabRendererHeight: number | null;
  cachedScrollInsets: ScrollInsets;
  cachedFooterItem: LineScrollItem | null;
  cachedCreditsItem: LineScrollItem | null;
  creditsFocused: boolean;
  cachedLineScrollTiming: Map<string, LineScrollTiming>;
  tabRendererResizeObserver: ResizeObserver | null;
  observedTabRenderer: HTMLElement | null;
  lineScrollAnimations: LineScrollAnimationRecord[];
  lineScrollAnimationToken: number;
  pendingLineScroll: PendingLineScroll | null;
  lineScrollElementTokens: WeakMap<HTMLElement, number>;
  visibleWillChangeElements: Set<HTMLElement>;
  culledLineElements: Set<HTMLElement>;
  waveAnimationPool: Animation[];
  lineCullObserver: IntersectionObserver | null;
  cachedDurations: Map<string, number>;
  cachedCSSValues: Map<string, string>;
  cachedAnimationSettings: AnimationSettings | null;
  /**
   * Last value the tick was given. The passive scroll loop runs from an animation frame rather than
   * from a tick, so it has no options object to read.
   */
  passiveScrollEnabled: boolean;
  /**
   * Last options the tick was given, kept before any early return. A click reads its offsets to seek
   * to where a line plays rather than to its unshifted time.
   */
  lastTickOptions: ResolvedTickOptions | null;
  playbackRate: number;
  passiveRAFId: number | null;
  pendingLyricsUpdateFrame: number | null;
  learnedAnimationTimingOffsetMs: number;
  animationTimingVisibilityLogUntil: number;
  layout: LyricsLayout;
  stageKey: string;
  stageRemeasured: boolean;
  stageHeight: number;
  stageBox: StageBox | null;
  stageMetrics: Map<HTMLElement, StageMetrics>;
  stageY: Map<HTMLElement, number>;
  stageMoves: Map<HTMLElement, Animation>;
  stageFades: Map<HTMLElement, Animation>;
  stageBlurs: Map<HTMLElement, Animation>;
  stageFontSize: number;
  /**
   * Releases everything the instance holds on its window: the reduced motion listener, the tab
   * renderer observer and any frame it still has queued.
   */
  destroy(): void;
}

export function createAnimationEngineInstance(
  engineDocument: Document,
  engineWindow: EngineWindow,
  host: LyricsRendererHost,
  layout: LyricsLayout = "scroll"
): AnimationEngineInstance {
  const reducedMotionQuery = engineWindow.matchMedia(REDUCED_MOTION_QUERY);
  const handleReducedMotionChange = (): void => clearStyleCaches(engine);

  const engine: AnimationEngineInstance = {
    document: engineDocument,
    window: engineWindow,
    host,
    lines: [],
    lyricsContainer: null,
    syncType: "none",
    lyricWidth: 0,
    lyricHeight: 0,
    skipScrolls: 0,
    skipScrollsDecayTimes: [],
    scrollResumeTime: 0,
    scrollPos: -1,
    selectedElementIndex: 0,
    wasUserScrolling: false,
    lastScrollElements: [],
    pinnedScrollLine: null,
    lastScrollDebugContext: {
      activeElms: [],
      centers: [],
      lyricScrollTime: 0,
    },
    passiveScrollAccumulatedTime: 0,
    passiveLastWallTime: 0,
    cachedTabRendererHeight: null,
    cachedScrollInsets: NO_SCROLL_INSETS,
    cachedFooterItem: null,
    cachedCreditsItem: null,
    creditsFocused: false,
    cachedLineScrollTiming: new Map(),
    tabRendererResizeObserver: null,
    observedTabRenderer: null,
    lineScrollAnimations: [],
    lineScrollAnimationToken: 0,
    pendingLineScroll: null,
    lineScrollElementTokens: new WeakMap(),
    visibleWillChangeElements: new Set(),
    culledLineElements: new Set(),
    waveAnimationPool: [],
    lineCullObserver: null,
    cachedDurations: new Map(),
    cachedCSSValues: new Map(),
    cachedAnimationSettings: null,
    passiveScrollEnabled: false,
    lastTickOptions: null,
    playbackRate: 1,
    passiveRAFId: null,
    pendingLyricsUpdateFrame: null,
    learnedAnimationTimingOffsetMs: 0,
    animationTimingVisibilityLogUntil: 0,
    layout,
    stageKey: "",
    stageRemeasured: false,
    stageHeight: 0,
    stageBox: null,
    stageMetrics: new Map(),
    stageY: new Map(),
    stageMoves: new Map(),
    stageFades: new Map(),
    stageBlurs: new Map(),
    stageFontSize: 16,
    destroy: () => {
      liveEngines.delete(engine);
      reducedMotionQuery.removeEventListener("change", handleReducedMotionChange);
      engine.tabRendererResizeObserver?.disconnect();
      engine.tabRendererResizeObserver = null;
      engine.observedTabRenderer = null;
      engine.lineCullObserver?.disconnect();
      engine.lineCullObserver = null;
      stopPassiveScrollLoop(engine);
      cancelLyricPositionUpdate(engine);
    },
  };

  reducedMotionQuery.addEventListener("change", handleReducedMotionChange);
  liveEngines.add(engine);
  return engine;
}

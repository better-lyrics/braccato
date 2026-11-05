import { registerThemeSetting } from "../themeSettings";
import { USER_SCROLLING_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { playbackClock } from "./clock";

const PASSIVE_SCROLL_ENABLED = registerThemeSetting("blyrics-passive-scroll-enabled", true);
const PASSIVE_SECONDS_PER_LINE = registerThemeSetting("blyrics-passive-scroll-seconds-per-line", 3.5);
const PASSIVE_BOTTOM_PAUSE_S = registerThemeSetting("blyrics-passive-scroll-bottom-pause-s", 1.5);
const PASSIVE_RESET_DURATION_S = registerThemeSetting("blyrics-passive-scroll-reset-duration-s", 0.6);
const PASSIVE_TOP_PAUSE_S = registerThemeSetting("blyrics-passive-scroll-top-pause-s", 0.8);

// -- Passive Scroll Engine --------------------------

/**
 * The "no lyrics" message is one line at time zero, which is shaped exactly like unsynced lyrics.
 * Nothing here applies to it: passive scroll would drift the message up and down for the length of
 * the song, and there is no line to sync.
 */
export function hasNoLyricsPlaceholder(engine: AnimationEngineInstance): boolean {
  return engine.lyricsContainer?.dataset.noLyrics === "true";
}

/**
 * Unsynced lyrics that this view still has on screen. `syncType` outlives the lyrics it was derived
 * from, so the container is the term that says they are still there.
 */
export function hasUnsyncedLyrics(engine: AnimationEngineInstance): boolean {
  return engine.lyricsContainer !== null && engine.syncType === "none" && !hasNoLyricsPlaceholder(engine);
}

export function stopPassiveScrollLoop(engine: AnimationEngineInstance): void {
  if (engine.passiveRAFId !== null) {
    engine.window.cancelAnimationFrame(engine.passiveRAFId);
    engine.passiveRAFId = null;
  }
}

export function startPassiveScrollLoop(engine: AnimationEngineInstance): void {
  if (engine.passiveRAFId !== null) return;
  engine.passiveRAFId = engine.window.requestAnimationFrame(() => passiveScrollRAFLoop(engine));
}

function passiveScrollRAFLoop(engine: AnimationEngineInstance): void {
  engine.passiveRAFId = null;
  if (!engine.passiveScrollEnabled || !PASSIVE_SCROLL_ENABLED.getBooleanValue() || !hasUnsyncedLyrics(engine)) return;

  passiveScrollEngine(engine, playbackClock.lastPlayState);
  engine.passiveRAFId = engine.window.requestAnimationFrame(() => passiveScrollRAFLoop(engine));
}

function passiveScrollEngine(engine: AnimationEngineInstance, isPlaying: boolean): void {
  if (!engine.host.isViewVisible()) return;

  if (engine.host.isLoaderActive()) return;

  const tabRenderer = engine.host.getScrollElement();
  if (!tabRenderer) return;

  const now = Date.now();

  // -- Accumulate play time --------------------------
  if (engine.passiveLastWallTime > 0 && isPlaying) {
    const wallDelta = (now - engine.passiveLastWallTime) / 1000;
    engine.passiveScrollAccumulatedTime += Math.min(wallDelta, 0.5);
  }
  engine.passiveLastWallTime = now;

  // -- User scroll interruption --------------------------
  if (engine.scrollResumeTime > now) {
    return;
  }

  if (engine.wasUserScrolling) {
    engine.host.setResumeAffordanceVisible(false);
    engine.lyricsContainer?.classList.remove(USER_SCROLLING_CLASS);
    engine.wasUserScrolling = false;

    // Re-sync accumulated time to current scroll position so scroll continues from where user left off
    const maxScroll = tabRenderer.scrollHeight - tabRenderer.clientHeight;
    if (maxScroll > 0) {
      const ratio = tabRenderer.scrollTop / maxScroll;
      const numLines = engine.lines.length;
      const scrollDuration = numLines * PASSIVE_SECONDS_PER_LINE.getNumberValue();
      engine.passiveScrollAccumulatedTime = ratio * scrollDuration;
    }
  }

  // -- Cycle calculation --------------------------
  const numLines = engine.lines.length;
  if (numLines === 0) return;

  const scrollDuration = numLines * PASSIVE_SECONDS_PER_LINE.getNumberValue();
  const bottomPause = PASSIVE_BOTTOM_PAUSE_S.getNumberValue();
  const resetDuration = PASSIVE_RESET_DURATION_S.getNumberValue();
  const topPause = PASSIVE_TOP_PAUSE_S.getNumberValue();
  const cycleLength = scrollDuration + bottomPause + resetDuration + topPause;

  const maxScroll = tabRenderer.scrollHeight - tabRenderer.clientHeight;
  if (maxScroll <= 0) return;

  const cycleTime = engine.passiveScrollAccumulatedTime % cycleLength;

  let targetScroll: number;
  if (cycleTime < scrollDuration) {
    // Phase 1: linear scroll down
    targetScroll = (cycleTime / scrollDuration) * maxScroll;
  } else if (cycleTime < scrollDuration + bottomPause) {
    // Phase 2: hold at bottom
    targetScroll = maxScroll;
  } else if (cycleTime < scrollDuration + bottomPause + resetDuration) {
    // Phase 3: ease-out scroll back to top
    const resetProgress = (cycleTime - scrollDuration - bottomPause) / resetDuration;
    const eased = 1 - (1 - resetProgress) * (1 - resetProgress);
    targetScroll = maxScroll * (1 - eased);
  } else {
    // Phase 4: hold at top
    targetScroll = 0;
  }

  const prevScrollTop = tabRenderer.scrollTop;
  tabRenderer.scrollTop = targetScroll;
  const appliedScrollTop = tabRenderer.scrollTop;
  // Only skip the next scroll event if scrollTop actually changed.
  // When it doesn't change (pause phases, sub-pixel rounding), no programmatic
  // scroll event fires, so setting skipScrolls would eat user scroll events instead.
  if (appliedScrollTop !== prevScrollTop) {
    engine.skipScrolls = 1;
  }
}

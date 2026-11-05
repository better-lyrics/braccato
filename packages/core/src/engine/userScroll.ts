import { USER_SCROLLING_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { forEveryLiveView } from "./liveViews";
import { dropPendingLineScroll } from "./lineScroll";
import { isPassiveDriftScroll } from "./passiveScroll";

const PAUSING_LYRICS_SCROLL_LOG = "Pausing Lyrics Autoscroll Due to User Scroll";

const USER_SCROLL_RESUME_DELAY_MS = 25000;
const PASSIVE_USER_SCROLL_RESUME_DELAY_MS = 5000;

// -- View operations --------------------------

/**
 * The user asked for autoscroll back, now.
 */
export function resetScrollResume(engine: AnimationEngineInstance): void {
  engine.scrollResumeTime = 0;
}

/**
 * The user asked for autoscroll back, now. Resuming is a property of playback rather than of one
 * view, so every live instance resumes. Published in this shape rather than as the registry walk
 * and the per view operation it is built from, so that nothing outside the module gets to name a
 * particular view.
 */
export function resumeAllAutoscroll(): void {
  forEveryLiveView(resetScrollResume);
}

/**
 * The user scrolled this view. Scrolls the engine itself performed are swallowed;
 * a real one pauses autoscroll long enough to read where it landed, and offers the way back.
 *
 * @param isPassive - Whether the lyrics on screen are unsynced, and so are drifting on their own
 *   rather than following the song. Those resume sooner.
 */
export function noteUserScroll(engine: AnimationEngineInstance, isPassive: boolean): void {
  if (isPassive) {
    if (isPassiveDriftScroll(engine)) return;
  } else if (engine.skipScrolls > 0) {
    engine.skipScrolls--;
    engine.skipScrollsDecayTimes.shift();
    return;
  }

  dropPendingLineScroll(engine);
  if (engine.host.isLoaderActive()) return;

  if (engine.scrollResumeTime < Date.now()) {
    engine.host.log(PAUSING_LYRICS_SCROLL_LOG);
  }
  engine.scrollResumeTime =
    Date.now() + (isPassive ? PASSIVE_USER_SCROLL_RESUME_DELAY_MS : USER_SCROLL_RESUME_DELAY_MS);
  engine.wasUserScrolling = true;

  engine.host.setResumeAffordanceVisible(true);
  engine.lyricsContainer?.classList.add(USER_SCROLLING_CLASS);
}

/**
 * Reports whether the container is a different size than the lines were last measured against, and
 * clears the scroll cooldown when it is so the caller's re-measurement can scroll immediately. The
 * new size is recorded by that re-measurement, not here.
 */
export function noteContainerResize(engine: AnimationEngineInstance, width: number, height: number): boolean {
  if (width === engine.lyricWidth && height === engine.lyricHeight) return false;
  return true;
}

const ENGINE_SCROLL_EVENT_WINDOW_MS = 2000;

export function writeEngineScrollTop(
  engine: AnimationEngineInstance,
  scroller: HTMLElement,
  scrollTop: number,
  now: number
): void {
  engine.scrollPos = scrollTop;
  const scrollTopBeforeWrite = scroller.scrollTop;
  scroller.scrollTop = scrollTop;
  if (scroller.scrollTop === scrollTopBeforeWrite) return;
  engine.skipScrolls += 1;
  engine.skipScrollsDecayTimes.push(now + ENGINE_SCROLL_EVENT_WINDOW_MS);
}

export function requestRescroll(engine: AnimationEngineInstance): void {
  engine.wasUserScrolling = true;
}

// -- Skip Scrolls Decay --------------------------

export function decaySkipScrolls(engine: AnimationEngineInstance, now: number, keepsReserve: boolean): void {
  let j = 0;
  for (; j < engine.skipScrollsDecayTimes.length; j++) {
    if (engine.skipScrollsDecayTimes[j] > now) {
      break;
    }
  }
  engine.skipScrollsDecayTimes = engine.skipScrollsDecayTimes.slice(j);
  engine.skipScrolls = Math.max(keepsReserve ? 1 : 0, engine.skipScrolls - j);
}

import { USER_SCROLLING_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { dropPendingLineScroll } from "./lineScroll";
import { forEveryLiveView } from "./liveViews";
import { isPassiveDriftScroll } from "./passiveScroll";

const PAUSING_LYRICS_SCROLL_LOG = "Pausing Lyrics Autoscroll Due to User Scroll";
const USER_SCROLL_RESUME_DELAY_MS = 25000;
const UNSYNCED_USER_SCROLL_RESUME_DELAY_MS = 5000;
const ENGINE_SCROLL_EVENT_WINDOW_MS = 2000;

export function resetScrollResume(engine: AnimationEngineInstance): void {
  engine.scrollResumeTime = 0;
}

/**
 * Resume autoscroll immediately for every live view.
 */
export function resumeAllAutoscroll(): void {
  forEveryLiveView(resetScrollResume);
}

export function noteUserScroll(engine: AnimationEngineInstance, lyricsAreUnsynced: boolean): void {
  if (lyricsAreUnsynced) {
    if (isPassiveDriftScroll(engine)) return;
  } else if (engine.skipScrolls > 0) {
    engine.skipScrolls--;
    engine.skipScrollsDecayTimes.shift();
    return;
  }

  dropPendingLineScroll(engine);
  if (engine.host.isLoaderActive()) return;

  const now = Date.now();
  if (engine.scrollResumeTime < now) engine.host.log(PAUSING_LYRICS_SCROLL_LOG);
  engine.scrollResumeTime =
    now + (lyricsAreUnsynced ? UNSYNCED_USER_SCROLL_RESUME_DELAY_MS : USER_SCROLL_RESUME_DELAY_MS);
  engine.wasUserScrolling = true;
  engine.host.setResumeAffordanceVisible(true);
  engine.lyricsContainer?.classList.add(USER_SCROLLING_CLASS);
}

export function hasContainerResized(engine: AnimationEngineInstance, width: number, height: number): boolean {
  return width !== engine.lyricWidth || height !== engine.lyricHeight;
}

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

export function decaySkipScrolls(engine: AnimationEngineInstance, now: number, keepsReserve: boolean): void {
  const firstLive = engine.skipScrollsDecayTimes.findIndex(time => time > now);
  const expiredCount = firstLive === -1 ? engine.skipScrollsDecayTimes.length : firstLive;
  engine.skipScrollsDecayTimes = engine.skipScrollsDecayTimes.slice(expiredCount);
  engine.skipScrolls = Math.max(keepsReserve ? 1 : 0, engine.skipScrolls - expiredCount);
}

import { registerThemeSetting } from "../themeSettings";
import type { ResolvedTickOptions, TickOptions } from "../types";
import type { LineData } from "../inject";
import { ANIMATING_CLASS, CREDITS_CLASS, CURRENT_LYRICS_CLASS, FOOTER_CLASS, USER_SCROLLING_CLASS } from "../constants";
import { clamp, getRelativeLayoutBounds } from "../util";
import {
  CLOCK_RESYNC_THRESHOLD_S,
  lyricClockShiftS,
  NO_PLAYER_SNAPSHOT,
  playbackClock,
  SMOOTH_PLAYBACK_CLOCK,
  smoothedPlaybackTime,
} from "./clock";
import type { AnimationEngineInstance } from "./instance";
import {
  applyPlaybackRateToRunningAnimations,
  canUseTimingSampleForDrift,
  correctedScrollTimeS,
  learnAnimationTimingOffset,
  lineNativeTimingSample,
} from "./animationTiming";
import {
  hasNoLyricsPlaceholder,
  hasUnsyncedLyrics,
  startPassiveScrollLoop,
  stopPassiveScrollLoop,
} from "./passiveScroll";
import {
  clearLineScrollAnimations,
  commitOrPrepareLineScroll,
  dropPendingLineScroll,
  getLineScrollItems,
  measureTrailingItem,
  prepareUpcomingLineScroll,
  SCROLL_PREPARE_LEAD_MS,
} from "./lineScroll";
import {
  clearOffscreenLineCulling,
  clearVisibleLyricWillChange,
  setupLineCullObserver,
  updateVisibleLyricWillChange,
} from "./culling";
import { getCSSDurationInMs } from "./cssValues";
import { getAnimationSettings } from "./animationConfig";
import {
  applyScrollPadding,
  computeActiveLinesScrollTop,
  findScrollAnchor,
  getTargetScrollRatio,
  measureScrollViewport,
  setupTabRendererObserver,
} from "./scrollViewport";
import {
  clearLineStateClasses,
  hasLineAnimations,
  markLineAnimationsStopped,
  resetLineAnimationState,
  setAnimationsPlayState,
  updateWordStates,
} from "./lineAnimationState";
import {
  ANIMATION_TIMING_ACCUMULATION_DECAY,
  ANIMATION_TIMING_ACCUMULATION_WEIGHT,
  ANIMATION_TIMING_RESET_THRESHOLD_MS,
  logAnimationCleanup,
  logAnimationTiming,
  shouldLogAnimationTiming,
} from "./timingLogs";
import { startLineAnimations, startLineExitAnimations } from "./lineAnimations";
import { applyStage, measureStage } from "./stageMotion";
import { decaySkipScrolls } from "./userScroll";
import { captureDecorationSlide, lineDecorators } from "./decorationSlides";

const NO_LYRICS_ELEMENT_LOG = "No lyrics element found on the page, skipping lyrics injection";
const LYRICS_CHECK_INTERVAL_ERROR = "Error in lyrics check interval:";

const LYRIC_ENDING_THRESHOLD_S = registerThemeSetting("blyrics-lyric-ending-threshold-s", 0.5);
const TIME_JUMP_THRESHOLD = 0.5;

const ENABLE_DEBUG_RENDER = registerThemeSetting("blyrics-debug-renderer", false);

/**
 * "lyrics-missing" means this instance has nothing left to render. Whether that ends ticking is the
 * driver's call, not the instance's: one instance running dry must not silence another.
 */
export type AnimationTickStatus = "ok" | "lyrics-missing";

/**
 * Fills in everything a caller left out of a tick. The tick reads each of these arithmetically, so
 * a missing one would not fail: it would quietly turn the playback time into NaN and leave the view
 * matching no line at all.
 */
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
    playbackRate: resolvePlaybackRate(options.playbackRate),
  };
}

// A rate of zero or less would freeze every animation that follows the song, which is a second
// answer to the question `isPlaying` already answers.
function resolvePlaybackRate(rate: number | undefined): number {
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : 1;
}

/**
 * Renders one view against a tick with nothing left out.
 */
export function tickView(
  engine: AnimationEngineInstance,
  currentTime: number,
  options: ResolvedTickOptions
): AnimationTickStatus {
  const { eventCreationTime, isPlaying, smoothScroll } = options;
  engine.lastTickOptions = options;
  engine.passiveScrollEnabled = options.passiveScrollEnabled;

  if (engine.playbackRate !== options.playbackRate) {
    engine.playbackRate = options.playbackRate;
    applyPlaybackRateToRunningAnimations(engine);
  }

  const now = Date.now();
  if (currentTime === 0 && !isPlaying) {
    return "ok";
  }

  if (hasNoLyricsPlaceholder(engine)) {
    stopPassiveScrollLoop(engine);
    return "ok";
  }

  if (hasUnsyncedLyrics(engine)) {
    // The stage shows lines by their time, and unsynced lines have none.
    if (engine.layout === "stage") return "ok";
    if (!playbackClock.lastPlayState && isPlaying) {
      engine.scrollResumeTime = 0;
    }
    playbackClock.lastPlayState = isPlaying;
    if (!options.passiveScrollEnabled) return "ok";
    startPassiveScrollLoop(engine);
    return "ok";
  }

  const timeJumped =
    Math.abs(currentTime - playbackClock.lastTime - (eventCreationTime - playbackClock.lastEventCreationTime) / 1000) >
    TIME_JUMP_THRESHOLD;
  // Without a player snapshot the reading is the media clock, which runs backwards only on a seek, so a
  // loop shorter than the jump threshold still re-arms lines. A snapshot host's extrapolated clock is
  // pulled back by every correction, so it is left to the threshold.
  const mediaSteppedBack =
    eventCreationTime === NO_PLAYER_SNAPSHOT &&
    isPlaying &&
    currentTime < playbackClock.lastTime - CLOCK_RESYNC_THRESHOLD_S;
  // A clock that was already paused only moves when the host seeks it, however small the step, as a
  // scrub does. The tick that pauses lands a moment past the last playing one and is not a seek.
  const pausedSeek = !isPlaying && !playbackClock.lastPlayState && currentTime !== playbackClock.lastTime;

  if (timeJumped) dropPendingLineScroll(engine);

  playbackClock.lastTime = currentTime;
  playbackClock.lastPlayState = isPlaying;
  playbackClock.lastEventCreationTime = eventCreationTime;

  let timeOffset = now - eventCreationTime;
  if (!isPlaying || eventCreationTime === NO_PLAYER_SNAPSHOT) {
    timeOffset = 0;
  }

  currentTime += timeOffset / 1000;

  if (SMOOTH_PLAYBACK_CLOCK) {
    if (isPlaying && !timeJumped) {
      currentTime = smoothedPlaybackTime(
        playbackClock.smoothedTime,
        playbackClock.smoothedAt,
        currentTime,
        now,
        engine.playbackRate
      );
    }
    playbackClock.smoothedTime = currentTime;
    playbackClock.smoothedAt = isPlaying ? now : NO_PLAYER_SNAPSHOT;
  }

  if (!engine.host.isViewVisible()) {
    clearVisibleLyricWillChange(engine);
    return "ok";
  }

  if (engine.host.syncAdState()) {
    return "ok";
  }

  try {
    const lyricsElement = engine.lyricsContainer;
    // If lyrics element doesn't exist, clear the interval and return silently
    if (!lyricsElement) {
      engine.host.log(NO_LYRICS_ELEMENT_LOG);
      return "lyrics-missing";
    }

    const lines = engine.lines;

    currentTime += lyricClockShiftS(engine, lyricsElement, options);

    const lyricScrollTime =
      correctedScrollTimeS(engine, currentTime) +
      getCSSDurationInMs(engine, lyricsElement, "--blyrics-scroll-timing-offset") / 1000;
    const { config: animationConfig, scrollTiming } = getAnimationSettings(engine, lyricsElement);

    // Read layout values before the loop writes class changes, to avoid forced reflow
    const isStage = engine.layout === "stage";
    const tabRenderer = isStage ? null : engine.host.getScrollElement();
    if (!isStage && !tabRenderer) {
      clearVisibleLyricWillChange(engine);
      return "ok";
    }
    if (tabRenderer && tabRenderer !== engine.observedTabRenderer) {
      setupTabRendererObserver(engine, tabRenderer);
    }
    const tabRendererHeight = tabRenderer
      ? (engine.cachedTabRendererHeight ?? tabRenderer.getBoundingClientRect().height)
      : 0;
    // Read before the loop's class writes so this layout read is batched and forces no mid-frame reflow.
    let scrollTop = tabRenderer?.scrollTop ?? 0;
    const maxScrollTop = tabRenderer ? Math.max(0, tabRenderer.scrollHeight - tabRenderer.clientHeight) : 0;
    if (!isStage && animationConfig.enabled.scroll) {
      updateVisibleLyricWillChange(
        engine,
        lines,
        scrollTop,
        engine.pendingLineScroll?.toScrollTop ?? scrollTop,
        tabRendererHeight
      );
    } else {
      dropPendingLineScroll(engine);
      clearVisibleLyricWillChange(engine);
      clearLineScrollAnimations(engine);
    }

    let activeElems = [] as LineData[];
    const linesToAnimate: LineData[] = [];
    let newLyricSelected = timeJumped;

    lines.every((lineData, index) => {
      const time = lineData.time;
      let nextTime = Infinity;
      if (index + 1 < lines.length) {
        const nextLyric = lines[index + 1];
        nextTime = nextLyric.time;
      }

      if (
        lyricScrollTime >= time - scrollTiming.earlyScrollConsiderS &&
        (lyricScrollTime < nextTime || lyricScrollTime < time + lineData.duration)
      ) {
        activeElems.push(lineData);
        if (!engine.lastScrollElements.includes(lineData) && lyricScrollTime >= time) {
          newLyricSelected = true;
        }

        // const timeDelta = lyricScrollTime - time;
        // if (engine.selectedElementIndex !== index && timeDelta > 0.05 && index > 0) {
        //   Utils.log(`[BetterLyrics] Scrolling to new lyric was late, dt: ${timeDelta.toFixed(5)}s`);
        // }
        engine.selectedElementIndex = index;
        if (!lineData.isScrolled) {
          lineData.lyricElement.classList.add(CURRENT_LYRICS_CLASS);
          lineData.isScrolled = true;
        }
      } else {
        if (lineData.isScrolled) {
          lineData.lyricElement.classList.remove(CURRENT_LYRICS_CLASS);
          lineData.isScrolled = false;
        }
      }

      /**
       * Time in seconds to set up animations. This shouldn't affect any visible effects, just help when the browser stutters
       */
      let setUpAnimationEarlyTime: number = 2;

      if (!isPlaying) {
        setUpAnimationEarlyTime = 0;
      }

      const effectiveEndTime = Math.max(nextTime, time + lineData.duration + 0.05);
      if (currentTime + setUpAnimationEarlyTime >= time && currentTime < effectiveEndTime) {
        if (!lineData.isSelected) {
          lineData.isSelected = true;
          lineData.lyricElement.classList.add(ANIMATING_CLASS);
        }

        if (isPlaying !== lineData.isAnimationPlayStatePlaying) {
          lineData.isAnimationPlayStatePlaying = isPlaying;
          setAnimationsPlayState(lineData, isPlaying);
          if (isPlaying) lineData.isAnimating = false; // reset the animation against current media time
        }

        // Lead-in animations have no timing sample for the drift check, so a jump while playing must reset them.
        if (((timeJumped && isPlaying) || mediaSteppedBack || pausedSeek) && lineData.isAnimating)
          resetLineAnimationState(lineData);

        updateWordStates(lineData, currentTime);

        const nativeTimingSample = lineNativeTimingSample(lineData, currentTime);
        let usedNativeTimingSampleForDrift = false;
        lineData.accumulatedOffsetMs = lineData.accumulatedOffsetMs / ANIMATION_TIMING_ACCUMULATION_DECAY;
        if (nativeTimingSample !== null && canUseTimingSampleForDrift(nativeTimingSample, isPlaying)) {
          usedNativeTimingSampleForDrift = true;
          const learnedOffsetMs = learnAnimationTimingOffset(engine, nativeTimingSample);
          const residualOffsetMs = nativeTimingSample.offsetMs;
          lineData.accumulatedOffsetMs += residualOffsetMs * ANIMATION_TIMING_ACCUMULATION_WEIGHT;
          if (shouldLogAnimationTiming(engine, lineData, nativeTimingSample, now)) {
            logAnimationTiming(
              engine,
              "sample",
              lineData,
              index,
              nativeTimingSample,
              currentTime,
              lineData.accumulatedOffsetMs,
              learnedOffsetMs,
              residualOffsetMs
            );
          }
        } else if (nativeTimingSample !== null && shouldLogAnimationTiming(engine, lineData, nativeTimingSample, now)) {
          logAnimationTiming(
            engine,
            "ignored-sample",
            lineData,
            index,
            nativeTimingSample,
            currentTime,
            lineData.accumulatedOffsetMs
          );
        }
        if (
          lineData.isAnimating &&
          usedNativeTimingSampleForDrift &&
          Math.abs(lineData.accumulatedOffsetMs) > ANIMATION_TIMING_RESET_THRESHOLD_MS &&
          isPlaying
        ) {
          if (nativeTimingSample !== null) {
            logAnimationTiming(
              engine,
              "drift-reset",
              lineData,
              index,
              nativeTimingSample,
              currentTime,
              lineData.accumulatedOffsetMs
            );
          }
          resetLineAnimationState(lineData);
        }

        if (!lineData.isAnimating) {
          // We'll take care of the animation setup in a batch later
          linesToAnimate.push(lineData);
        }
      } else {
        const staleAnimationEndTime = effectiveEndTime + animationConfig.highlight.fadeOutDurationMs / 1000 + 0.05;
        if (lineData.isSelected) {
          if (isPlaying || timeJumped || pausedSeek) {
            if (currentTime > staleAnimationEndTime) {
              logAnimationCleanup(engine, "selected-stale-reset", lineData, index, currentTime, staleAnimationEndTime);
              resetLineAnimationState(lineData);
            } else {
              startLineExitAnimations(engine, lineData, animationConfig, currentTime);
              markLineAnimationsStopped(lineData);
            }
          } else {
            setAnimationsPlayState(lineData, false);
            lineData.isAnimationPlayStatePlaying = false;
          }
          lineData.isSelected = false;
          clearLineStateClasses(lineData);
          updateWordStates(lineData, currentTime);
        } else if (hasLineAnimations(lineData) && (timeJumped || currentTime > staleAnimationEndTime)) {
          logAnimationCleanup(
            engine,
            timeJumped ? "time-jump-reset" : "stale-reset",
            lineData,
            index,
            currentTime,
            staleAnimationEndTime
          );
          resetLineAnimationState(lineData);
        }
        if (timeJumped) {
          updateWordStates(lineData, currentTime);
        }
      }
      return true;
    });

    if (linesToAnimate.length > 0) {
      for (const lineData of linesToAnimate) {
        startLineAnimations(engine, lineData, animationConfig, currentTime);
        lineData.isAnimating = true;
        lineData.lastAnimSetupAt = now;
        lineData.isAnimationPlayStatePlaying = isPlaying;
        lineData.accumulatedOffsetMs = 0;
        if (!isPlaying) setAnimationsPlayState(lineData, false);
      }
    }

    const lastSungLine = lines.findLast(lineData => lineData.lyricElement.dataset.instrumental !== "true");
    const creditsFocused =
      lastSungLine !== undefined &&
      (engine.cachedCreditsItem?.height ?? 0) > 0 &&
      lyricScrollTime >= lastSungLine.time + lastSungLine.duration;
    if (creditsFocused !== engine.creditsFocused) {
      engine.creditsFocused = creditsFocused;
      if (creditsFocused) lyricsElement.dataset.creditsFocused = "true";
      else delete lyricsElement.dataset.creditsFocused;
      newLyricSelected = true;
    }

    if (isStage || !tabRenderer) {
      if (isStage) applyStage(engine, currentTime, timeJumped);
      return "ok";
    }

    if (engine.scrollResumeTime < Date.now() || engine.scrollPos === -1) {
      if (activeElems.length == 0) {
        activeElems.push(lines[0]);
      }

      // Offset so lyrics appear towards the center of the screen.
      const scrollPosOffset = tabRendererHeight * getTargetScrollRatio(engine, lyricsElement);

      let lastActiveLyric = activeElems[activeElems.length - 1];

      // Ignore lyrics close to finishing unless it is the last active lyric.
      const sungLines = activeElems.filter(
        (lineData, index) =>
          lyricScrollTime < lineData.time + lineData.duration - LYRIC_ENDING_THRESHOLD_S.getNumberValue() ||
          index == activeElems.length - 1
      );
      const lyricPositions = sungLines.map(lineData => lineData.position + lineData.height / 2);
      const scrollInsets = engine.cachedScrollInsets;

      const scrollAnchor = findScrollAnchor(sungLines, lyricScrollTime);
      const scrollTarget = computeActiveLinesScrollTop(
        sungLines,
        scrollAnchor,
        tabRendererHeight,
        scrollInsets,
        scrollPosOffset
      );
      let scrollPos = scrollTarget.scrollTop;
      const pinned = engine.pinnedScrollLine;
      if (
        pinned &&
        pinned !== scrollAnchor &&
        (!sungLines.includes(pinned) || lyricScrollTime >= pinned.time + pinned.duration)
      ) {
        newLyricSelected = true;
      }

      const credits = engine.cachedCreditsItem;
      if (engine.creditsFocused && credits && lastSungLine) {
        // Tall credits would otherwise carry the last line out of view while it is still being sung.
        scrollPos = Math.min(
          credits.position + credits.height / 2 - scrollPosOffset,
          lastSungLine.position - scrollInsets.top
        );
      }

      // Past either end the browser clamps the write and reports nothing, leaving the view aiming
      // at a position it never reached and re-aiming once per remaining line.
      scrollPos = clamp(scrollPos, 0, maxScrollTop);

      if (ENABLE_DEBUG_RENDER.getBooleanValue()) {
        let transform = engine.window.getComputedStyle(lyricsElement).transform;
        const matrix = new engine.window.DOMMatrix(transform);
        let yTransform = matrix.f;
        let yTop = scrollTop - yTransform;
        const ctx = engine.host.debug?.beginFrame(yTop);
        if (ctx) {
          ctx.strokeStyle = "green";
          ctx.fillStyle = "green";
          ctx?.fillText("visible top", 0, scrollTop);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop);
          ctx?.lineTo(1000, scrollTop);
          ctx.stroke();

          ctx.strokeStyle = "blue";
          ctx.fillStyle = "blue";
          ctx?.fillText("visible bottom", 0, scrollTop + tabRendererHeight);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop + tabRendererHeight);
          ctx?.lineTo(1000, scrollTop + tabRendererHeight);
          ctx.stroke();

          ctx.strokeStyle = "yellow";
          ctx.fillStyle = "yellow";
          ctx?.fillText("target", 0, scrollTop + scrollPosOffset);
          ctx?.beginPath();
          ctx?.moveTo(40, scrollTop + scrollPosOffset);
          ctx?.lineTo(1000, scrollTop + scrollPosOffset);
          ctx.stroke();

          function debugLyrics(
            xOffset: number,
            name: string,
            activeElems: LineData[],
            lyricPositions: number[],
            lyricScrollTime: number
          ) {
            ctx!.strokeStyle = "red";
            ctx!.fillStyle = "red";
            ctx!.fillText(name, xOffset + 2, yTop + 45);
            ctx!.fillText("scroll time: " + lyricScrollTime.toFixed(3), xOffset + 2, yTop + 60);

            activeElems.forEach(elm => {
              let timeTillActive = elm.time - lyricScrollTime;
              let endTime = elm.time + elm.duration;
              let timeTillEnd = endTime - lyricScrollTime;
              if (timeTillEnd < LYRIC_ENDING_THRESHOLD_S.getNumberValue()) {
                ctx!.strokeStyle = "gray";
                ctx!.fillStyle = "gray";
              } else if (timeTillActive > 0) {
                ctx!.strokeStyle = "magenta";
                ctx!.fillStyle = "magenta";
              } else {
                ctx!.strokeStyle = "orange";
                ctx!.fillStyle = "orange";
              }

              ctx?.beginPath();
              ctx?.moveTo(xOffset + 5, elm.position);
              ctx?.lineTo(xOffset + 5, elm.position + elm.height);
              ctx?.stroke();
              ctx?.fillText(
                "time: start=" + elm.time.toFixed(2) + " end=" + endTime.toFixed(2),
                xOffset + 15,
                elm.position
              );
              ctx?.fillText("till active: " + timeTillActive.toFixed(2), xOffset + 15, elm.position + 15);
              ctx?.fillText("till end: " + timeTillEnd.toFixed(2), xOffset + 15, elm.position + 30);
            });

            ctx!.strokeStyle = "pink";
            ctx!.fillStyle = "pink";
            lyricPositions.forEach(lyricPosition => {
              ctx?.beginPath();
              ctx?.arc(xOffset + 5, lyricPosition, 5, 0, 2 * Math.PI, false);
              ctx?.fill();
            });
          }

          debugLyrics(0, "realtime", activeElems, lyricPositions, lyricScrollTime);
          debugLyrics(
            160,
            "last scroll",
            engine.lastScrollDebugContext.activeElms,
            engine.lastScrollDebugContext.centers,
            engine.lastScrollDebugContext.lyricScrollTime
          );
        }
      }

      const timeUntilUpcomingScrollMs = (lastActiveLyric.time - lyricScrollTime) * 1000;
      // Only a scroll from where the engine itself left the view keeps the theme's full stagger.
      const naturalAdvance =
        !timeJumped && !engine.wasUserScrolling && engine.scrollPos >= 0 && Math.abs(scrollTop - engine.scrollPos) <= 2;
      if (
        smoothScroll &&
        animationConfig.enabled.scroll &&
        !newLyricSelected &&
        !engine.wasUserScrolling &&
        timeUntilUpcomingScrollMs > 0 &&
        timeUntilUpcomingScrollMs <= SCROLL_PREPARE_LEAD_MS &&
        !engine.lastScrollElements.includes(lastActiveLyric) &&
        Math.abs(scrollTop - scrollPos) > 2
      ) {
        updateVisibleLyricWillChange(engine, lines, scrollTop, scrollPos, tabRendererHeight);
        prepareUpcomingLineScroll(
          engine,
          getLineScrollItems(engine, lines),
          lastActiveLyric,
          scrollPos - scrollTop,
          scrollTop,
          scrollPos,
          tabRendererHeight,
          animationConfig,
          naturalAdvance
        );
      }

      if (engine.wasUserScrolling || newLyricSelected) {
        // Remember future lines only when their group is committed, so they cannot scroll
        // again at their start. Entering the lookahead window alone does not commit a group.
        engine.lastScrollElements = activeElems;
        engine.pinnedScrollLine = scrollTarget.overflowsBand ? scrollAnchor : null;
        engine.lastScrollDebugContext.lyricScrollTime = lyricScrollTime;
        engine.lastScrollDebugContext.centers = lyricPositions;
        engine.lastScrollDebugContext.activeElms = activeElems;

        if (smoothScroll && Math.abs(scrollTop - scrollPos) > 2) {
          const scrollDeltaPx = scrollPos - scrollTop;
          if (animationConfig.enabled.scroll) {
            updateVisibleLyricWillChange(engine, lines, scrollTop, scrollPos, tabRendererHeight);
            const lineScrollItems = getLineScrollItems(engine, lines);
            commitOrPrepareLineScroll(
              engine,
              lineScrollItems,
              lastActiveLyric,
              scrollDeltaPx,
              scrollTop,
              scrollPos,
              tabRendererHeight,
              animationConfig,
              naturalAdvance
            );
          }
        } else {
          dropPendingLineScroll(engine);
        }

        scrollTop = scrollPos;
        engine.scrollPos = scrollTop;
        tabRenderer.scrollTop = scrollTop;
        engine.skipScrolls += 1;
        engine.skipScrollsDecayTimes.push(Date.now() + 2000);
      }
    }

    if (engine.wasUserScrolling && engine.scrollResumeTime < Date.now()) {
      engine.host.setResumeAffordanceVisible(false);
      lyricsElement.classList.remove(USER_SCROLLING_CLASS);
      engine.wasUserScrolling = false;
    }

    decaySkipScrolls(engine, now);
  } catch (err) {
    if (!(err as Error).message?.includes("undefined")) {
      engine.host.log(LYRICS_CHECK_INTERVAL_ERROR, err);
    }
  }

  return "ok";
}

/**
 * Re-reads the view's layout: the scroll padding first, then the line positions the padding moved.
 *
 * @param measureLines - Pass false while the lines are not being rendered. An unrendered container
 *   measures every line as zero height at zero offset, which would leave the scroll maths with
 *   nothing to work from once rendering resumes.
 */
export function relayout(engine: AnimationEngineInstance, measureLines: boolean): void {
  if (engine.layout === "stage") {
    if (!measureLines || !engine.lyricsContainer) return;
    engine.cachedCreditsItem = measureTrailingItem(engine.lyricsContainer, CREDITS_CLASS);
    measureStage(engine);
    return;
  }
  applyScrollPadding(engine);
  const scrollElement = engine.host.getScrollElement();
  if (scrollElement) measureScrollViewport(engine, scrollElement);
  if (!measureLines) return;

  const lyricsElement = engine.lyricsContainer;
  if (!lyricsElement) return;
  // Both dimensions, because both are what a resize is compared against. The scroll padding written
  // above lands on this container, so a measurement that records only the width leaves every later
  // resize report looking like a new height, and each one measures again and forces a rescroll.
  engine.lyricWidth = lyricsElement.clientWidth;
  engine.lyricHeight = lyricsElement.clientHeight;

  // Skipped lines report intrinsic size, so un-cull before the walk reads offsetTop/offsetHeight.
  clearOffscreenLineCulling(engine);

  for (const line of engine.lines) {
    const bounds = getRelativeLayoutBounds(lyricsElement, line.lyricElement);
    line.position = bounds.y;
    line.height = bounds.height;
    line.decorations = new Map(
      lineDecorators(line.lyricElement).map(element => [element, getRelativeLayoutBounds(lyricsElement, element).y])
    );
  }

  engine.cachedCreditsItem = measureTrailingItem(lyricsElement, CREDITS_CLASS);
  engine.cachedFooterItem = measureTrailingItem(lyricsElement, FOOTER_CLASS);

  // Re-arm from the fresh measurements, so a line skipped after this holds its new placeholder height.
  setupLineCullObserver(engine);

  engine.wasUserScrolling = true; // trigger rescrolls
  engine.host.debug?.resize();
}

// -- Debounced Lyrics Update --------------------------

export function cancelLyricPositionUpdate(engine: AnimationEngineInstance): void {
  if (engine.pendingLyricsUpdateFrame === null) return;
  engine.window.cancelAnimationFrame(engine.pendingLyricsUpdateFrame);
  engine.pendingLyricsUpdateFrame = null;
}

/**
 * Renders this view again against the last player snapshot, without moving the clock on. The
 * options are built now rather than handed in, so a caller that reads settings at tick time still
 * reads them at tick time.
 *
 * @param buildTickOptions - Given the snapshot the tick will run against, returns what to render it
 *   with.
 */
export function retickFromPlaybackClock(
  engine: AnimationEngineInstance,
  buildTickOptions: (eventCreationTime: number, isPlaying: boolean) => TickOptions
): AnimationTickStatus {
  return tickView(
    engine,
    playbackClock.lastTime,
    resolveTickOptions(buildTickOptions(playbackClock.lastEventCreationTime, playbackClock.lastPlayState))
  );
}

/**
 * Called when a new lyrics element is added to trigger re-sync.
 * Debounced via requestAnimationFrame to avoid O(n²) layout thrashing
 * when translations/romanizations load (each addition would otherwise
 * re-measure ALL lines).
 *
 * @param isViewRendering - Asked on the frame rather than now. A driver that has stopped ticking is
 *   one whose lines may no longer be rendered, and an unrendered line measures as nothing, so a
 *   false answer declines both the re-measurement and the re-tick.
 * @param retick - Runs after the re-measurement, on the frame.
 */
export function scheduleLyricPositionUpdate(
  engine: AnimationEngineInstance,
  isViewRendering: () => boolean,
  retick: () => void
): void {
  if (engine.pendingLyricsUpdateFrame !== null) {
    return;
  }
  dropPendingLineScroll(engine);
  engine.pendingLyricsUpdateFrame = engine.window.requestAnimationFrame(() => {
    engine.pendingLyricsUpdateFrame = null;
    const isRendering = isViewRendering();
    const playSlide = isRendering ? captureDecorationSlide(engine) : null;
    relayout(engine, isRendering);
    playSlide?.();
    if (!isRendering) return;
    retick();
  });
}

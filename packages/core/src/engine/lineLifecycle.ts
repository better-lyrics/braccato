import { ANIMATING_CLASS } from "../constants";
import type { LineData } from "../inject";
import type { AnimationConfig } from "./animationConfig";
import { correctLineDrift } from "./animationDrift";
import type { Playhead } from "./clock";
import type { AnimationEngineInstance } from "./instance";
import { startLineAnimations, startLineExitAnimations } from "./lineAnimations";
import {
  clearLineStateClasses,
  hasLineAnimations,
  markLineAnimationsStopped,
  resetLineAnimationState,
  setAnimationsPlayState,
  updateWordStates,
} from "./lineAnimationState";
import { logAnimationCleanup } from "./timingLogs";

const ANIMATION_PREPARE_AHEAD_S = 2;
const LINE_END_GRACE_S = 0.05;
const STALE_ANIMATION_GRACE_S = 0.05;

interface LineTick {
  engine: AnimationEngineInstance;
  lyricTimeS: number;
  playhead: Playhead;
  config: AnimationConfig;
  now: number;
}

export function driveLineAnimations(tick: LineTick): void {
  const { engine, lyricTimeS, playhead } = tick;
  const lines = engine.lines;
  const prepareAheadS = playhead.isPlaying ? ANIMATION_PREPARE_AHEAD_S : 0;
  const linesToStart: LineData[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const nextLineStartS = lines[index + 1]?.time ?? Infinity;
    const animationEndS = Math.max(nextLineStartS, line.time + line.duration + LINE_END_GRACE_S);
    if (lyricTimeS + prepareAheadS >= line.time && lyricTimeS < animationEndS) {
      updateLineAnimationState(tick, line, index);
      if (!line.isAnimating) linesToStart.push(line);
    } else {
      retireLine(tick, line, index, animationEndS);
    }
  }

  for (const line of linesToStart) startLine(tick, line);
}

function updateLineAnimationState(tick: LineTick, line: LineData, index: number): void {
  const { lyricTimeS, playhead } = tick;
  if (!line.isSelected) {
    line.isSelected = true;
    line.lyricElement.classList.add(ANIMATING_CLASS);
  }

  if (line.isAnimationPlayStatePlaying !== playhead.isPlaying) {
    line.isAnimationPlayStatePlaying = playhead.isPlaying;
    setAnimationsPlayState(line, playhead.isPlaying);
    if (playhead.isPlaying) line.isAnimating = false;
  }

  const playbackDiscontinuity =
    (playhead.jumped && playhead.isPlaying) || playhead.mediaClockRanBackwards || playhead.seekedWhilePaused;
  if (playbackDiscontinuity && line.isAnimating) resetLineAnimationState(line);

  updateWordStates(line, lyricTimeS);
  correctLineDrift({
    engine: tick.engine,
    line,
    lineIndex: index,
    lyricTimeS,
    isPlaying: playhead.isPlaying,
    now: tick.now,
  });
}

function retireLine(
  { engine, lyricTimeS, playhead, config }: LineTick,
  line: LineData,
  index: number,
  animationEndS: number
): void {
  const staleAfterS = animationEndS + config.highlight.fadeOutDurationMs / 1000 + STALE_ANIMATION_GRACE_S;
  const isStale = lyricTimeS > staleAfterS;
  const wasSelected = line.isSelected;

  if (wasSelected) {
    if (playhead.isPlaying || playhead.jumped || playhead.seekedWhilePaused) {
      if (isStale) {
        logAnimationCleanup(engine, "selected-stale-reset", line, index, lyricTimeS, staleAfterS);
        resetLineAnimationState(line);
      } else {
        startLineExitAnimations(line, config, lyricTimeS);
        markLineAnimationsStopped(line);
      }
    } else {
      setAnimationsPlayState(line, false);
      line.isAnimationPlayStatePlaying = false;
    }
    line.isSelected = false;
    clearLineStateClasses(line);
  } else if (hasLineAnimations(line) && (playhead.jumped || isStale)) {
    logAnimationCleanup(
      engine,
      playhead.jumped ? "time-jump-reset" : "stale-reset",
      line,
      index,
      lyricTimeS,
      staleAfterS
    );
    resetLineAnimationState(line);
  }

  if (wasSelected || playhead.jumped) updateWordStates(line, lyricTimeS);
}

function startLine({ engine, lyricTimeS, playhead, config, now }: LineTick, line: LineData): void {
  startLineAnimations(engine, line, config, lyricTimeS);
  line.isAnimating = true;
  line.lastAnimSetupAt = now;
  line.isAnimationPlayStatePlaying = playhead.isPlaying;
  line.accumulatedOffsetMs = 0;
  if (!playhead.isPlaying) setAnimationsPlayState(line, false);
}

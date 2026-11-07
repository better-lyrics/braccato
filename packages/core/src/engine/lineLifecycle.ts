import { ANIMATING_CLASS } from "../constants";
import type { LineData } from "../inject";
import type { AnimationConfig } from "./animationConfig";
import { canUseTimingSampleForDrift, learnAnimationTimingOffset, lineNativeTimingSample } from "./animationTiming";
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
import {
  ANIMATION_TIMING_ACCUMULATION_DECAY,
  ANIMATION_TIMING_ACCUMULATION_WEIGHT,
  ANIMATION_TIMING_RESET_THRESHOLD_MS,
  logAnimationCleanup,
  logAnimationTiming,
  shouldLogAnimationTiming,
} from "./timingLogs";

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
  correctAnimationDrift(tick, line, index);
}

function correctAnimationDrift({ engine, lyricTimeS, playhead, now }: LineTick, line: LineData, index: number): void {
  const sample = lineNativeTimingSample(line, lyricTimeS);
  line.accumulatedOffsetMs /= ANIMATION_TIMING_ACCUMULATION_DECAY;
  if (sample === null) return;

  if (!canUseTimingSampleForDrift(sample, playhead.isPlaying)) {
    if (shouldLogAnimationTiming(engine, line, sample, now)) {
      logAnimationTiming(engine, "ignored-sample", line, index, sample, lyricTimeS, line.accumulatedOffsetMs);
    }
    return;
  }

  const learnedOffsetMs = learnAnimationTimingOffset(engine, sample);
  line.accumulatedOffsetMs += sample.offsetMs * ANIMATION_TIMING_ACCUMULATION_WEIGHT;
  if (shouldLogAnimationTiming(engine, line, sample, now)) {
    const accumulatedMs = line.accumulatedOffsetMs;
    logAnimationTiming(
      engine,
      "sample",
      line,
      index,
      sample,
      lyricTimeS,
      accumulatedMs,
      learnedOffsetMs,
      sample.offsetMs
    );
  }

  const drifted = Math.abs(line.accumulatedOffsetMs) > ANIMATION_TIMING_RESET_THRESHOLD_MS;
  if (line.isAnimating && playhead.isPlaying && drifted) {
    logAnimationTiming(engine, "drift-reset", line, index, sample, lyricTimeS, line.accumulatedOffsetMs);
    resetLineAnimationState(line);
  }
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
        startLineExitAnimations(engine, line, config, lyricTimeS);
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

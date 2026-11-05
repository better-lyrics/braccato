import type { AnimationData, LineData, PartData } from "../inject";
import {
  ANIMATING_CLASS,
  PAUSED_CLASS,
  WORD_STATE_ACTIVE,
  WORD_STATE_ATTR,
  WORD_STATE_PAST,
  WORD_STATE_UPCOMING,
  type WordState,
} from "../constants";
import { waveAnimationPools } from "./wavePool";

export function releasePart(part: PartData): void {
  resetPartAnimations(part);
  togglePartClass(part, PAUSED_CLASS, false);
  togglePartClass(part, ANIMATING_CLASS, false);
  part.wordState = WORD_STATE_UPCOMING;
  part.lyricElement.setAttribute(WORD_STATE_ATTR, WORD_STATE_UPCOMING);
  part.highlightElement.setAttribute(WORD_STATE_ATTR, WORD_STATE_UPCOMING);
  part.imageLayers?.highlight?.setAttribute(WORD_STATE_ATTR, WORD_STATE_UPCOMING);
}

export function resetPartAnimations(part: AnimationData): void {
  for (const animation of part.animations) {
    animation.cancel();
    const pool = waveAnimationPools.get(animation);
    if (pool) pool.push(animation);
  }
  part.animations = [];
}

function resetLineAnimations(lineData: LineData): void {
  resetPartAnimations(lineData);
  for (const part of lineData.parts) resetPartAnimations(part);
}

export function hasLineAnimations(lineData: LineData): boolean {
  return [lineData, ...lineData.parts].some(part => part.animations.length > 0);
}

export function markLineAnimationsStopped(lineData: LineData): void {
  lineData.isAnimating = false;
  lineData.isAnimationPlayStatePlaying = false;
  lineData.accumulatedOffsetMs = 0;
}

export function resetLineAnimationState(lineData: LineData): void {
  resetLineAnimations(lineData);
  markLineAnimationsStopped(lineData);
}

export function togglePartClass(part: LineData | PartData, className: string, force: boolean): void {
  part.lyricElement.classList.toggle(className, force);
  if ("highlightElement" in part) {
    part.highlightElement.classList.toggle(className, force);
    part.imageLayers?.highlight?.classList.toggle(className, force);
  }
}

export function setAnimationsPlayState(lineData: LineData, isPlaying: boolean): void {
  const children = [lineData, ...lineData.parts];
  for (const part of children) {
    togglePartClass(part, PAUSED_CLASS, !isPlaying);
    for (const animation of part.animations) {
      if (isPlaying) {
        animation.play();
      } else {
        animation.pause();
      }
    }
  }
}

export function clearLineStateClasses(lineData: LineData): void {
  lineData.lyricElement.classList.remove(ANIMATING_CLASS);
  for (const part of [lineData, ...lineData.parts]) {
    togglePartClass(part, PAUSED_CLASS, false);
  }
}

export function updateWordStates(lineData: LineData, currentTime: number): void {
  const parts = lineData.parts;
  const lineEndTime = lineData.time + lineData.duration;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const endTime = part.duration > 0 ? part.time + part.duration : (parts[i + 1]?.time ?? lineEndTime);
    let state: WordState = WORD_STATE_PAST;
    if (currentTime < part.time) {
      state = WORD_STATE_UPCOMING;
    } else if (currentTime < endTime) {
      state = WORD_STATE_ACTIVE;
    }
    if (part.wordState === state) continue;
    part.wordState = state;
    part.lyricElement.setAttribute(WORD_STATE_ATTR, state);
    part.highlightElement.setAttribute(WORD_STATE_ATTR, state);
    part.imageLayers?.highlight?.setAttribute(WORD_STATE_ATTR, state);
  }
}

import type { PartData } from "../inject";
import type { AnimationConfig } from "./animationConfig";

export function activeTextGradientKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      "--lyric-transition-amount-start": config.highlight.swipeStartFrom,
      "--lyric-transition-amount-end": config.highlight.swipeEndFrom,
    },
    {
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

export function activeTextGlowKeyframes(config: AnimationConfig, part: PartData): Keyframe[] {
  if (part.imageLayers)
    return [
      { filter: `blur(${config.highlight.imageGlowFrom})`, opacity: config.highlight.imageGlowOpacityFrom },
      { filter: `blur(${config.highlight.imageGlowTo})`, opacity: config.highlight.imageGlowOpacityTo },
    ];
  return [{ filter: config.highlight.glowFrom }, { filter: config.highlight.glowTo }];
}

export function activeTextVisibleKeyframes(): Keyframe[] {
  return [{ opacity: 1 }, { opacity: 1 }];
}

export function activeTextInstantKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      opacity: 1,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
    {
      opacity: 1,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

export function lineSyncedTextKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    {
      opacity: 0,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
    {
      opacity: 1,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

export function fadeOutTextKeyframes(config: AnimationConfig, part: PartData): Keyframe[] {
  return [
    {
      opacity: 1,
      filter: part.imageLayers ? "none" : config.highlight.glowTo,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
    {
      opacity: 0,
      filter: part.imageLayers ? "none" : config.highlight.glowTo,
      "--lyric-transition-amount-start": config.highlight.swipeStartTo,
      "--lyric-transition-amount-end": config.highlight.swipeEndTo,
    },
  ] as Keyframe[];
}

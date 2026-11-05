import type { PartData } from "../inject";
import type { AnimationConfig } from "./animationConfig";

type SwipeEnd = "from" | "to";

function swipeAmounts({ highlight }: AnimationConfig, end: SwipeEnd): Keyframe {
  return {
    "--lyric-transition-amount-start": end === "from" ? highlight.swipeStartFrom : highlight.swipeStartTo,
    "--lyric-transition-amount-end": end === "from" ? highlight.swipeEndFrom : highlight.swipeEndTo,
  } as Keyframe;
}

export function swipeKeyframes(config: AnimationConfig): Keyframe[] {
  return [swipeAmounts(config, "from"), swipeAmounts(config, "to")];
}

export function glowKeyframes({ highlight }: AnimationConfig, part: PartData): Keyframe[] {
  if (!part.imageLayers) return [{ filter: highlight.glowFrom }, { filter: highlight.glowTo }];
  return [
    { filter: `blur(${highlight.imageGlowFrom})`, opacity: highlight.imageGlowOpacityFrom },
    { filter: `blur(${highlight.imageGlowTo})`, opacity: highlight.imageGlowOpacityTo },
  ];
}

export function shownKeyframes(): Keyframe[] {
  return [{ opacity: 1 }, { opacity: 1 }];
}

export function shownFullySweptKeyframes(config: AnimationConfig): Keyframe[] {
  const shown = { opacity: 1, ...swipeAmounts(config, "to") };
  return [shown, shown];
}

export function fadeInFullySweptKeyframes(config: AnimationConfig): Keyframe[] {
  return [
    { opacity: 0, ...swipeAmounts(config, "to") },
    { opacity: 1, ...swipeAmounts(config, "to") },
  ];
}

export function fadeOutKeyframes(config: AnimationConfig, part: PartData): Keyframe[] {
  const filter = part.imageLayers ? "none" : config.highlight.glowTo;
  return [
    { opacity: 1, filter, ...swipeAmounts(config, "to") },
    { opacity: 0, filter, ...swipeAmounts(config, "to") },
  ];
}

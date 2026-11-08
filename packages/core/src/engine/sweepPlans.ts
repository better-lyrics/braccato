import { clamp } from "../util";
import type { SwipeRamp } from "./letterPlans";

/** Keyframes for a sweep cell's mask and for the text inside it, offsets in eased swipe progress. */
export interface CellSweep {
  mask: Keyframe[];
  text: Keyframe[];
}

/**
 * The swipe's stops, in widths of the word: everything before `start` is lit and everything past
 * `start + fade` is not. The mask's soft edge is static, so it takes the width the swipe ends with.
 */
interface SwipeStops {
  startFrom: number;
  startTo: number;
  fade: number;
}

function swipeStops(swipe: SwipeRamp): SwipeStops | null {
  const startFrom = Number.parseFloat(swipe.startFrom);
  const startTo = Number.parseFloat(swipe.startTo);
  const fade = Number.parseFloat(swipe.endTo) - startTo;
  if (![startFrom, startTo, fade].every(Number.isFinite) || startTo <= startFrom) return null;
  return { startFrom, startTo, fade: Math.max(fade, 0) };
}

/** A cell's place along its word, as fractions of the word's width. */
export interface CellSpan {
  start: number;
  width: number;
}

/**
 * The swipe's soft edge in a cell's own widths. `.blyrics-sweep-mask` reads the same value as
 * `--blyrics-sweep-fade`, so the two must agree.
 */
export function cellFade(swipe: SwipeRamp, span: CellSpan): number {
  const stops = swipeStops(swipe);
  return stops && span.width > 0 ? stops.fade / span.width : 0;
}

/**
 * Plans one cell of a sweep. In the cell's own widths the start stop runs from
 * `(startFrom - span.start) / span.width` to `(startTo - span.start) / span.width`, and the cell only
 * changes while that is between `-fade` (nothing lit yet) and `1` (all of it lit), so the motion is
 * clamped there. `.blyrics-sweep-mask` in lyrics.css is `3 + fade` cells wide, starting a cell before
 * the cell, with its soft edge from the end of the cell to `fade` cells further; at rest the cell is
 * fully lit. The start stop moves linearly in eased progress, so keyframes at the clamp points with
 * the swipe's easing on the whole effect follow it exactly.
 */
export function planCellSweep(swipe: SwipeRamp, span: CellSpan, rtl: boolean): CellSweep | null {
  const stops = swipeStops(swipe);
  if (!stops || span.width <= 0) return null;
  const fade = stops.fade / span.width;
  const maskWidths = 3 + fade;
  const sign = rtl ? -1 : 1;
  const startAt = (progress: number) =>
    (stops.startFrom + (stops.startTo - stops.startFrom) * progress - span.start) / span.width;
  const progressAt = (start: number) =>
    (start * span.width + span.start - stops.startFrom) / (stops.startTo - stops.startFrom);

  const offsets = [0, progressAt(-fade), progressAt(1), 1].map(offset => clamp(offset, 0, 1));
  const unique = offsets.filter((offset, position) => offsets.indexOf(offset) === position);
  const mask: Keyframe[] = [];
  const text: Keyframe[] = [];
  for (const offset of unique) {
    const behind = sign * (clamp(startAt(offset), -fade, 1) - 1);
    mask.push({ offset, translate: `${(behind * 100) / maskWidths}% 0` });
    text.push({ offset, translate: `${-behind * 100}% 0` });
  }
  return { mask, text };
}

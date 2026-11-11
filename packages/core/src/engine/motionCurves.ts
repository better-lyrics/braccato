export interface MotionCurve {
  startMs: number;
  durationMs: number;
  fromPx: number;
  toPx: number;
  easing: string;
  endEasing: string;
}

export type Easing = (progress: number) => number;
export type EasingLookup = (easing: string) => Easing;

export interface BakedMotion {
  keyframes: Keyframe[];
  startMs: number;
  durationMs: number;
}

const TOLERANCE_PX = 0.1;
const LONGEST_STOP_SPAN_MS = 100;
const SHORTEST_STOP_SPAN_MS = 1;

interface MotionStop {
  timeMs: number;
  offsetPx: number;
}

type Path = (timeMs: number) => number;

export function curveEndMs(curve: MotionCurve): number {
  return curve.startMs + curve.durationMs;
}

export function isRunningAt(curve: MotionCurve, timeMs: number): boolean {
  return curve.startMs <= timeMs && timeMs < curveEndMs(curve);
}

export function offsetAt(curves: readonly MotionCurve[], timeMs: number, easingOf: EasingLookup): number {
  return curves
    .filter(curve => isRunningAt(curve, timeMs))
    .reduce((sum, curve) => sum + easedOffset(curve, easingOf(curve.easing), timeMs), 0);
}

export function bakeMotion(curves: readonly MotionCurve[], nowMs: number, easingOf: EasingLookup): BakedMotion {
  if (curves.length === 1) return exactly(curves[0]);

  const endsMs = [...new Set(curves.map(curveEndMs))].sort((a, b) => a - b);
  const stops: MotionStop[] = [];
  let fromMs = nowMs;
  for (const toMs of endsMs) {
    const running = curves
      .filter(curve => curve.startMs <= fromMs && curveEndMs(curve) >= toMs)
      .map(curve => ({ curve, easing: easingOf(curve.easing) }));
    const path: Path = timeMs => {
      let offsetPx = 0;
      for (const { curve, easing } of running) offsetPx += easedOffset(curve, easing, timeMs);
      return offsetPx;
    };
    const fromPx = path(fromMs);
    if (stops.at(-1)?.offsetPx !== fromPx) stops.push({ timeMs: fromMs, offsetPx: fromPx });
    const spans = Math.ceil((toMs - fromMs) / LONGEST_STOP_SPAN_MS);
    for (let span = 1; span <= spans; span++) {
      const spanEndMs = fromMs + ((toMs - fromMs) * span) / spans;
      appendStops(path, stops[stops.length - 1], { timeMs: spanEndMs, offsetPx: path(spanEndMs) }, stops);
    }
    fromMs = toMs;
  }

  const durationMs = endsMs[endsMs.length - 1] - nowMs;
  const fullScalePx = Math.max(...stops.map(stop => Math.abs(stop.offsetPx))) || 1;
  const easing = `linear(${stops
    .map(
      ({ timeMs, offsetPx }) => `${rounded(offsetPx / fullScalePx)} ${rounded((100 * (timeMs - nowMs)) / durationMs)}%`
    )
    .join(", ")})`;
  return {
    keyframes: [
      { translate: translateOf(0), easing },
      { translate: translateOf(fullScalePx), easing: "linear" },
    ],
    startMs: nowMs,
    durationMs,
  };
}

function appendStops(path: Path, from: MotionStop, to: MotionStop, stops: MotionStop[]): void {
  const middleMs = (from.timeMs + to.timeMs) / 2;
  const middle = { timeMs: middleMs, offsetPx: path(middleMs) };
  const chordPx = (from.offsetPx + to.offsetPx) / 2;
  if (Math.abs(middle.offsetPx - chordPx) <= TOLERANCE_PX || to.timeMs - from.timeMs <= SHORTEST_STOP_SPAN_MS) {
    stops.push(to);
    return;
  }
  appendStops(path, from, middle, stops);
  appendStops(path, middle, to, stops);
}

function exactly(curve: MotionCurve): BakedMotion {
  return {
    keyframes: [
      { translate: translateOf(curve.fromPx), easing: curve.easing },
      { translate: translateOf(curve.toPx), easing: curve.endEasing },
    ],
    startMs: curve.startMs,
    durationMs: curve.durationMs,
  };
}

function easedOffset(curve: MotionCurve, easing: Easing, timeMs: number): number {
  const progress = curve.durationMs > 0 ? Math.min(1, (timeMs - curve.startMs) / curve.durationMs) : 1;
  return curve.fromPx + (curve.toPx - curve.fromPx) * easing(progress);
}

function translateOf(offsetPx: number): string {
  return `0px ${Math.round(offsetPx * 1000) / 1000}px`;
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

import type { AnimationEngineInstance } from "./instance";
import { bakeMotion, curveEndMs, type Easing, type EasingLookup, type MotionCurve, offsetAt } from "./motionCurves";

export type MotionKind = "scroll" | "slide";

export interface ElementCurve extends MotionCurve {
  kind: MotionKind;
  onEnd?: () => void;
}

export interface ElementMotion {
  animation: Animation;
  curves: ElementCurve[];
}

const EASING_TABLE_STEPS = 128;

export function timelineNow(engine: AnimationEngineInstance): number {
  const timelineTime = engine.document.timeline?.currentTime;
  return typeof timelineTime === "number" ? timelineTime : Date.now();
}

export function addElementCurve(engine: AnimationEngineInstance, element: HTMLElement, curve: ElementCurve): void {
  const nowMs = timelineNow(engine);
  playCurves(engine, element, [...runningCurves(engine, element, nowMs), curve], nowMs);
}

export function removeElementCurves(engine: AnimationEngineInstance, element: HTMLElement, kind: MotionKind): void {
  const nowMs = timelineNow(engine);
  const running = runningCurves(engine, element, nowMs);
  if (!running.some(curve => curve.kind === kind)) return;
  playCurves(
    engine,
    element,
    running.filter(curve => curve.kind !== kind),
    nowMs
  );
}

export function stopElementMotion(engine: AnimationEngineInstance, element: HTMLElement): void {
  const motion = engine.elementMotions.get(element);
  if (!motion) return;
  engine.elementMotions.delete(element);
  motion.animation.cancel();
  for (const curve of motion.curves) curve.onEnd?.();
}

export function stopAllElementMotion(engine: AnimationEngineInstance): void {
  for (const element of [...engine.elementMotions.keys()]) stopElementMotion(engine, element);
}

export function elementMotionOffsetPx(engine: AnimationEngineInstance, element: HTMLElement): number {
  const motion = engine.elementMotions.get(element);
  return motion ? offsetAt(motion.curves, timelineNow(engine), easingLookup(engine)) : 0;
}

function runningCurves(engine: AnimationEngineInstance, element: HTMLElement, nowMs: number): ElementCurve[] {
  return (engine.elementMotions.get(element)?.curves ?? []).filter(curve => curveEndMs(curve) > nowMs);
}

function playCurves(
  engine: AnimationEngineInstance,
  element: HTMLElement,
  curves: ElementCurve[],
  nowMs: number
): void {
  const previous = engine.elementMotions.get(element);
  for (const curve of previous?.curves ?? []) if (!curves.includes(curve)) curve.onEnd?.();
  if (curves.length === 0) {
    engine.elementMotions.delete(element);
    previous?.animation.cancel();
    return;
  }
  const baked = bakeMotion(curves, nowMs, easingLookup(engine));
  const animation = element.animate(baked.keyframes, { duration: baked.durationMs, easing: "linear", fill: "none" });
  animation.startTime = baked.startMs;
  const motion: ElementMotion = { animation, curves };
  engine.elementMotions.set(element, motion);
  previous?.animation.cancel();

  const settle = () => {
    if (engine.elementMotions.get(element) !== motion) return;
    engine.elementMotions.delete(element);
    for (const curve of curves) curve.onEnd?.();
  };
  animation.addEventListener("finish", settle, { once: true });
  animation.addEventListener("cancel", settle, { once: true });
}

export function easingLookup(engine: AnimationEngineInstance): EasingLookup {
  return easing => {
    let table = engine.easingTables.get(easing);
    if (!table) {
      table = sampleEasing(engine, easing);
      engine.easingTables.set(easing, table);
    }
    return tableEasing(table);
  };
}

function tableEasing(table: Float64Array): Easing {
  return progress => {
    const position = Math.min(Math.max(progress, 0), 1) * EASING_TABLE_STEPS;
    const step = Math.min(Math.floor(position), EASING_TABLE_STEPS - 1);
    return table[step] + (table[step + 1] - table[step]) * (position - step);
  };
}

function sampleEasing(engine: AnimationEngineInstance, easing: string): Float64Array {
  const table = Float64Array.from({ length: EASING_TABLE_STEPS + 1 }, (_, step) => step / EASING_TABLE_STEPS);
  const { KeyframeEffect: Effect, Animation: Player } = engine.window;
  if (typeof Effect !== "function" || typeof Player !== "function") return table;
  try {
    const effect = new Effect(null, null, { duration: EASING_TABLE_STEPS, easing, fill: "both" });
    const player = new Player(effect, null);
    for (let step = 0; step <= EASING_TABLE_STEPS; step++) {
      player.currentTime = step;
      table[step] = effect.getComputedTiming().progress ?? table[step];
    }
  } catch (error) {
    engine.host.log("Line motion easing could not be sampled, so it is treated as linear", easing, error);
  }
  return table;
}

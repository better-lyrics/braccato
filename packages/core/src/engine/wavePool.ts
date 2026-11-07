import type { AnimationEngineInstance } from "./instance";

// Finished per-letter wave animations are pooled and retargeted onto new letters, since recreating
// ~150 identical ones per line activation is pure churn.
export const pooledWaveAnimations = new WeakMap<Animation, Animation[]>();
const pooledWaveKeyframeSignatures = new WeakMap<Animation, string>();

export function acquireWaveAnimation(
  engine: AnimationEngineInstance,
  letterElement: HTMLElement,
  keyframes: Keyframe[],
  keyframeSignature: string,
  timing: { duration: number; delay: number; endDelay: number; fill: FillMode }
): Animation {
  const pool = engine.waveAnimationPool;
  const pooled = pool[pool.length - 1];
  const effect = pooled?.effect as KeyframeEffect | null | undefined;
  if (pooled && effect && typeof effect.setKeyframes === "function") {
    pool.pop();
    effect.target = letterElement;
    if (pooledWaveKeyframeSignatures.get(pooled) !== keyframeSignature) {
      effect.setKeyframes(keyframes);
      pooledWaveKeyframeSignatures.set(pooled, keyframeSignature);
    }
    effect.updateTiming(timing);
    pooled.play();
    return pooled;
  }
  const animation = letterElement.animate(keyframes, timing);
  pooledWaveAnimations.set(animation, pool);
  pooledWaveKeyframeSignatures.set(animation, keyframeSignature);
  return animation;
}

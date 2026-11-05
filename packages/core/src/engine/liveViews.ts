import type { AnimationEngineInstance } from "./instance";

export const liveEngines = new Set<AnimationEngineInstance>();

export function forEveryLiveView(runOperation: (engine: AnimationEngineInstance) => void): void {
  for (const engine of liveEngines) runOperation(engine);
}

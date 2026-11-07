import type { AnimationEngineInstance } from "./instance";

/**
 * Every instance that has been created and not yet destroyed. Operations that describe the song
 * rather than one view are addressed to all of them: nothing outside this module gets to name a
 * particular view, so nothing outside it can leave one showing lyrics the others have dropped.
 */
export const liveEngines = new Set<AnimationEngineInstance>();

/**
 * Runs an operation against every live instance. Cheap enough for a scroll or a song change, and
 * deliberately not used inside the tick, which runs per frame and per line.
 */
export function forEveryLiveView(runOperation: (engine: AnimationEngineInstance) => void): void {
  for (const engine of liveEngines) {
    runOperation(engine);
  }
}

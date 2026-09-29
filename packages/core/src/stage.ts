export type StageItemKind = "line" | "instrumental" | "credits";
export type StageRole = "current" | "next" | "previous" | "queued" | "gone";

export interface StageItem {
  kind: StageItemKind;
  /** Seconds. */
  start: number;
  /** Seconds. The credits hold the stage until the song ends, so theirs is infinite. */
  end: number;
}

export interface StageTiming {
  /** Shows the next item under the current one. */
  preview: boolean;
}

export const STAGE_LEAD_S = 0.5;
export const STAGE_HANDOFF_S = 0.12;
export const STAGE_OVERLAP_S = 0.15;
export const STAGE_LINGER_S = 0.32;

export function overlapsPrevious(items: readonly StageItem[], index: number): boolean {
  const previous = items[index - 1];
  return previous !== undefined && previous.kind === "line" && items[index].start < previous.end - STAGE_OVERLAP_S;
}

export function stageEnterTimes(items: readonly StageItem[], timing: StageTiming): number[] {
  return items.map((item, index) => {
    const early = item.start - STAGE_LEAD_S;
    const previous = items[index - 1];
    if (timing.preview || previous?.kind !== "line" || overlapsPrevious(items, index)) return early;
    return Math.max(early, Math.min(previous.end, item.start) - STAGE_HANDOFF_S);
  });
}

export function planStage(items: readonly StageItem[], timeS: number, timing: StageTiming): StageRole[] {
  const enterTimes = stageEnterTimes(items, timing);
  let current = -1;
  enterTimes.forEach((enterTime, index) => {
    if (enterTime <= timeS) current = index;
  });
  const roles: StageRole[] = items.map((_, index) =>
    index < current ? "gone" : index > current ? "queued" : "current"
  );
  if (current < 0) return roles;

  const previous = items[current - 1];
  if (previous?.kind === "line") {
    const keep = timing.preview
      ? timeS < previous.end + STAGE_LINGER_S
      : overlapsPrevious(items, current) && timeS < previous.end;
    if (keep) roles[current - 1] = "previous";
  }
  if (timing.preview && current + 1 < items.length) roles[current + 1] = "next";
  return roles;
}

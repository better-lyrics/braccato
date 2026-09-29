export type StageItemKind = "line" | "instrumental" | "credits";
export type StageRole = "current" | "previous" | "queued" | "gone";

export interface StageItem {
  kind: StageItemKind;
  /** Seconds. */
  start: number;
  /** Seconds. The credits hold the stage until the song ends, so theirs is infinite. */
  end: number;
}

export const STAGE_LEAD_S = 0.5;
export const STAGE_HANDOFF_S = 0.12;
export const STAGE_OVERLAP_S = 0.15;

export function overlapsPrevious(items: readonly StageItem[], index: number): boolean {
  const previous = items[index - 1];
  return previous !== undefined && previous.kind === "line" && items[index].start < previous.end - STAGE_OVERLAP_S;
}

export function stageEnterTimes(items: readonly StageItem[]): number[] {
  return items.map((item, index) => {
    const early = item.start - STAGE_LEAD_S;
    const previous = items[index - 1];
    // An outro note would otherwise keep the credits off stage until the song ends.
    if (item.kind === "credits" && previous?.kind === "instrumental") return (previous.start + previous.end) / 2;
    if (previous?.kind !== "line" || overlapsPrevious(items, index)) return early;
    return Math.max(early, Math.min(previous.end, item.start) - STAGE_HANDOFF_S);
  });
}

export function planStage(items: readonly StageItem[], timeS: number): StageRole[] {
  const enterTimes = stageEnterTimes(items);
  let current = -1;
  enterTimes.forEach((enterTime, index) => {
    if (enterTime <= timeS) current = index;
  });
  const roles: StageRole[] = items.map((_, index) =>
    index < current ? "gone" : index > current ? "queued" : "current"
  );
  if (current < 0) return roles;

  const previous = items[current - 1];
  if (previous?.kind === "line" && overlapsPrevious(items, current) && timeS < previous.end) {
    roles[current - 1] = "previous";
  }
  return roles;
}

export interface StageMetrics {
  height: number;
  left: number;
  width: number;
  /** Where the item scales from horizontally: 0 left, 0.5 centre, 1 right. */
  originX: number;
}

export interface StageGeometry {
  stageHeight: number;
  gap: number;
  activeScale: number;
}

export interface StagePlacement {
  y: number;
  visible: boolean;
}

export interface StageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function unionBox(box: StageBox | null, next: StageBox): StageBox {
  if (box === null) return next;
  const x = Math.min(box.x, next.x);
  const y = Math.min(box.y, next.y);
  return {
    x,
    y,
    width: Math.max(box.x + box.width, next.x + next.width) - x,
    height: Math.max(box.y + box.height, next.y + next.height) - y,
  };
}

/** Where a line waits below the floor, and where it rises from as it enters. */
export function queuedStageY(stageHeight: number, height: number, gap: number): number {
  return stageHeight - height + gap;
}

export function layoutStage(
  roles: readonly StageRole[],
  items: readonly StageItem[],
  metrics: readonly StageMetrics[],
  previousY: readonly (number | null)[],
  geometry: StageGeometry
): { placements: StagePlacement[]; box: StageBox | null } {
  const { stageHeight, gap } = geometry;
  const current = roles.indexOf("current");
  const currentY = current >= 0 ? stageHeight - metrics[current].height : stageHeight;

  const placements = roles.map((role, index): StagePlacement => {
    const { height } = metrics[index];
    switch (role) {
      case "current":
        return { y: currentY, visible: true };
      case "previous":
        return { y: currentY - gap - height, visible: true };
      case "queued":
        return { y: queuedStageY(stageHeight, height, gap), visible: false };
      case "gone":
        return { y: previousY[index] ?? currentY, visible: false };
    }
  });

  let box: StageBox | null = null;
  roles.forEach((role, index) => {
    if ((role !== "current" && role !== "previous") || items[index].kind === "instrumental") return;
    const { height, left, width, originX } = metrics[index];
    const scale = geometry.activeScale;
    box = unionBox(box, {
      x: left + width * originX * (1 - scale),
      y: placements[index].y + (height * (1 - scale)) / 2,
      width: width * scale,
      height: height * scale,
    });
  });
  return { placements, box };
}

import type { LineData } from "../inject";
import {
  layoutStage,
  planStage,
  queuedStageY,
  type StageBox,
  type StageItem,
  type StagePlacement,
  type StageSpanRect,
  stageTextSpan,
} from "../stage";
import { CREDITS_CLASS } from "../constants";
import type { AnimationEngineInstance } from "./instance";
import { getCSSNumber } from "./cssValues";
import { REDUCED_MOTION_QUERY } from "./motionPreference";

/**
 * Starts the same animation on another element at the point the first one has reached, or answers
 * null when there is nothing left of it to carry on.
 */
function continueAnimation(animation: Animation | undefined, element: HTMLElement): Animation | null {
  const effect = animation?.effect as KeyframeEffect | null | undefined;
  if (!animation || !effect || typeof effect.getKeyframes !== "function" || animation.playState === "finished") {
    return null;
  }
  if (animation.playState === "idle") return null;
  const continued = element.animate(effect.getKeyframes(), { ...effect.getTiming(), composite: effect.composite });
  continued.playbackRate = animation.playbackRate;
  continued.currentTime = animation.currentTime;
  if (animation.playState === "paused") continued.pause();
  return continued;
}

/**
 * Moves what the stage held for each replaced line onto the line built in its place, and lets go of
 * every dropped line. A replacement starts exactly where and as visible as the line it replaced, so
 * placing the stage afterwards only moves it if the new song puts it somewhere else.
 */
export function replaceStageElements(
  engine: AnimationEngineInstance,
  dropped: readonly LineData[],
  replaced: ReadonlyMap<LineData, LineData>
): void {
  for (const [line, previous] of replaced) {
    const element = line.lyricElement;
    const role = previous.lyricElement.dataset.stageRole;
    const y = engine.stageY.get(previous.lyricElement);
    if (role === undefined || y === undefined) continue;
    element.dataset.stageRole = role;
    const visible = previous.lyricElement.dataset.stageVisible !== undefined;
    if (visible) element.dataset.stageVisible = "";
    // A line replaced mid-glide carries on gliding from wherever the one it replaced had got to.
    const move = continueAnimation(engine.stageMoves.get(previous.lyricElement), element);
    if (move === null) {
      snapStageElement(engine, element, y);
    } else {
      engine.stageMoves.set(element, move);
      engine.stageY.set(element, y);
    }
    const fade =
      continueAnimation(engine.stageFades.get(previous.lyricElement), element) ??
      element.animate([{ [STAGE_OPACITY_PROPERTY]: isStageRoleVisible(role) ? 1 : 0 }], {
        duration: 0,
        fill: "forwards",
      });
    if (!isStageRoleVisible(role)) {
      fade.onfinish = () => {
        if (engine.stageFades.get(element) === fade) delete element.dataset.stageVisible;
      };
    }
    engine.stageFades.set(element, fade);
    const blur = continueAnimation(engine.stageBlurs.get(previous.lyricElement), element);
    if (blur !== null) engine.stageBlurs.set(element, blur);
  }
  for (const line of dropped) {
    const element = line.lyricElement;
    for (const animations of [engine.stageMoves, engine.stageFades, engine.stageBlurs]) {
      animations.get(element)?.cancel();
      animations.delete(element);
    }
    engine.stageY.delete(element);
    engine.stageMetrics.delete(element);
  }
  // The roles are planned again against the new lines, even where they come out the same.
  engine.stageKey = "";
}

export function resetStage(engine: AnimationEngineInstance): void {
  for (const animation of [
    ...engine.stageMoves.values(),
    ...engine.stageFades.values(),
    ...engine.stageBlurs.values(),
  ]) {
    animation.cancel();
  }
  engine.stageMoves.clear();
  engine.stageFades.clear();
  engine.stageBlurs.clear();
  engine.stageMetrics.clear();
  engine.stageY.clear();
  engine.stageKey = "";
  engine.stageHeight = 0;
  if (engine.stageBox !== null) {
    engine.stageBox = null;
    engine.host.onStageLayout?.(null);
  }
}

// -- Stage layout --------------------------------------------

const STAGE_MOTION = { durationMs: 380, easing: "cubic-bezier(0.2, 0, 0, 1)" };
// Read by an important rule in stage.css, so a theme's own important opacity cannot reveal a line
// the stage is hiding or fading.
const STAGE_OPACITY_PROPERTY = "--blyrics-stage-opacity";
const stageOpacityRegistrations = new WeakSet<object>();
const STAGE_FADE_IN_MS = 300;
const STAGE_FADE_IN_DELAY_MS = 70;
const STAGE_FADE_OUT_MS = 220;
// Lines blur out and in across a handoff, so one reads as turning into the next.
const STAGE_BLUR = "blur(3px)";
const STAGE_GAP_EM = 0.32;

function stageElements(engine: AnimationEngineInstance): { elements: HTMLElement[]; items: StageItem[] } {
  const elements: HTMLElement[] = [];
  const items: StageItem[] = [];
  let lastEnd = 0;
  for (const line of engine.lines) {
    const end = line.time + line.duration;
    lastEnd = Math.max(lastEnd, end);
    elements.push(line.lyricElement);
    items.push({
      kind:
        line.lyricElement.dataset.instrumental === "true"
          ? "instrumental"
          : line.lyricElement.dataset.blank === "true"
            ? "blank"
            : "line",
      start: line.time,
      end,
    });
  }
  const credits = engine.lyricsContainer?.querySelector<HTMLElement>(`:scope > .${CREDITS_CLASS}`);
  if (credits) {
    elements.push(credits);
    items.push({ kind: "credits", start: lastEnd, end: Number.POSITIVE_INFINITY });
  }
  return { elements, items };
}

function originXOf(align: string): number {
  if (align === "center") return 0.5;
  if (align === "right" || align === "end") return 1;
  return 0;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

function contentWidthOf(element: HTMLElement, style: CSSStyleDeclaration): number {
  return (
    element.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)
  );
}

// A block that fills its parent is looked inside; inline boxes and shrunk blocks (the romanization pill) count whole.
function collectContentRects(
  engine: AnimationEngineInstance,
  range: Range,
  node: HTMLElement,
  contentWidth: number,
  rects: StageSpanRect[]
): StageSpanRect[] {
  for (const child of node.childNodes) {
    if (child.nodeType === TEXT_NODE) {
      range.selectNodeContents(child);
      rects.push(...range.getClientRects());
      continue;
    }
    if (child.nodeType !== ELEMENT_NODE) continue;
    const element = child as HTMLElement;
    const style = engine.window.getComputedStyle(element);
    if (style.display === "none") continue;
    if (style.display === "contents") {
      collectContentRects(engine, range, element, contentWidth, rects);
    } else if (style.display.startsWith("inline")) {
      rects.push(...element.getClientRects());
    } else if (element.offsetWidth < contentWidth - 1) {
      rects.push(element.getBoundingClientRect());
    } else {
      collectContentRects(engine, range, element, contentWidthOf(element, style), rects);
    }
  }
  return rects;
}

export function measureStage(engine: AnimationEngineInstance): void {
  engine.stageMetrics.clear();
  const container = engine.lyricsContainer;
  if (!container) return;
  engine.stageFontSize = Number.parseFloat(engine.window.getComputedStyle(container).fontSize) || 16;
  const range = engine.document.createRange();
  for (const element of stageElements(engine).elements) {
    const style = engine.window.getComputedStyle(element);
    const originX = originXOf(style.textAlign);
    const span = stageTextSpan(
      element.offsetLeft,
      element.offsetWidth,
      element.getBoundingClientRect(),
      collectContentRects(engine, range, element, contentWidthOf(element, style), []),
      { left: Number.parseFloat(style.paddingLeft) || 0, right: Number.parseFloat(style.paddingRight) || 0 },
      originX
    );
    engine.stageMetrics.set(element, {
      height: element.offsetHeight,
      left: span.left,
      width: span.width,
      originX,
    });
  }
  engine.stageKey = "";
  engine.stageRemeasured = true;
}

export function currentTranslateY(engine: AnimationEngineInstance, element: HTMLElement, fallback: number): number {
  const parts = engine.window.getComputedStyle(element).translate.split(" ");
  const y = Number.parseFloat(parts[1] ?? "");
  return Number.isFinite(y) ? y : fallback;
}

interface StageMove {
  element: HTMLElement;
  placement: StagePlacement;
  wasVisible: boolean;
  fromY: number;
  fromOpacity: number;
}

function snapStageElement(engine: AnimationEngineInstance, element: HTMLElement, y: number): void {
  engine.stageMoves.get(element)?.cancel();
  engine.stageMoves.set(element, element.animate([{ translate: `0 ${y}px` }], { duration: 0, fill: "forwards" }));
  engine.stageY.set(element, y);
}

function placeStageElement(
  engine: AnimationEngineInstance,
  { element, placement, wasVisible, fromY, fromOpacity }: StageMove,
  instant: boolean,
  reduced: boolean
): void {
  engine.stageMoves.get(element)?.cancel();
  engine.stageFades.get(element)?.cancel();

  const moveMs = instant || reduced ? 0 : STAGE_MOTION.durationMs;
  engine.stageMoves.set(
    element,
    element.animate([{ translate: `0 ${fromY}px` }, { translate: `0 ${placement.y}px` }], {
      duration: moveMs,
      easing: STAGE_MOTION.easing,
      fill: "forwards",
    })
  );
  const fadeMs = instant ? 0 : placement.visible ? STAGE_FADE_IN_MS : STAGE_FADE_OUT_MS;
  if (placement.visible) element.dataset.stageVisible = "";
  else if (fadeMs === 0) delete element.dataset.stageVisible;
  const fade = element.animate(
    [{ [STAGE_OPACITY_PROPERTY]: fromOpacity }, { [STAGE_OPACITY_PROPERTY]: placement.visible ? 1 : 0 }],
    {
      duration: fadeMs,
      delay: placement.visible && !instant ? STAGE_FADE_IN_DELAY_MS : 0,
      easing: placement.visible ? "ease-out" : "ease",
      // Backwards too: the fade replaces one that was cancelled, and through its delay the line would
      // otherwise drop to the stylesheet's resting opacity of zero.
      fill: "both",
    }
  );
  if (!placement.visible && fadeMs > 0) {
    fade.onfinish = () => {
      if (engine.stageFades.get(element) === fade) delete element.dataset.stageVisible;
    };
  }
  engine.stageFades.set(element, fade);
  engine.stageY.set(element, placement.y);

  engine.stageBlurs.get(element)?.cancel();
  engine.stageBlurs.delete(element);
  if (fadeMs === 0 || reduced || wasVisible === placement.visible) return;
  const blurs = ["none", STAGE_BLUR];
  engine.stageBlurs.set(
    element,
    element.animate(
      (placement.visible ? blurs.reverse() : blurs).map(filter => ({ filter })),
      {
        duration: fadeMs,
        delay: placement.visible ? STAGE_FADE_IN_DELAY_MS : 0,
        easing: placement.visible ? "ease-out" : "ease",
        // Added to the theme's own filter rather than replacing it, and held only until the line is in focus.
        composite: "add",
        fill: placement.visible ? "backwards" : "forwards",
      }
    )
  );
}

// Registered from script rather than with @property, which Firefox ignores in a stylesheet
// cross-origin to the document. Unregistered, the fade would snap instead of interpolating.
function registerStageOpacity(engine: AnimationEngineInstance): void {
  const css = engine.window.CSS;
  if (stageOpacityRegistrations.has(engine.window) || typeof css?.registerProperty !== "function") return;
  stageOpacityRegistrations.add(engine.window);
  try {
    css.registerProperty({ name: STAGE_OPACITY_PROPERTY, syntax: "<number>", inherits: false, initialValue: "0" });
  } catch (error) {
    engine.host.log("Stage opacity property was already registered", error);
  }
}

function isStageRoleVisible(role: string): boolean {
  return role !== "queued" && role !== "gone";
}

function sameBox(a: StageBox | null, b: StageBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

export function applyStage(engine: AnimationEngineInstance, timeS: number, instant: boolean): void {
  const container = engine.lyricsContainer;
  if (!container) return;
  registerStageOpacity(engine);
  const { elements, items } = stageElements(engine);
  const roles = planStage(items, timeS);
  const key = roles.join(",");
  if (key === engine.stageKey && !instant) return;
  engine.stageKey = key;
  const remeasured = engine.stageRemeasured;
  engine.stageRemeasured = false;

  const metrics = elements.map(
    element => engine.stageMetrics.get(element) ?? { height: 0, left: 0, width: 0, originX: 0 }
  );
  const geometry = {
    stageHeight: container.clientHeight,
    gap: engine.stageFontSize * STAGE_GAP_EM,
    activeScale: getCSSNumber(engine, container, "--blyrics-active-scale", 1),
  };
  // Lines sit on the floor, so a resize moves every place by how far the floor moved.
  const floorShift = remeasured && engine.stageHeight > 0 ? geometry.stageHeight - engine.stageHeight : 0;
  engine.stageHeight = geometry.stageHeight;
  const { placements, box } = layoutStage(
    roles,
    items,
    metrics,
    elements.map(element => {
      const y = engine.stageY.get(element);
      return y === undefined ? null : y + floorShift;
    }),
    geometry
  );
  // Only the elements whose place changed move. A line that stays where it is keeps its running
  // animations, and one already hidden stays hidden without being animated again.
  const moves: StageMove[] = [];
  elements.forEach((element, index) => {
    const placement = placements[index];
    const previousY = engine.stageY.get(element);
    const wasVisible = element.dataset.stageRole !== undefined && isStageRoleVisible(element.dataset.stageRole);
    const unchanged =
      previousY !== undefined && wasVisible === placement.visible && (!placement.visible || previousY === placement.y);
    // After a resize a line still on screen, fading out included, jumps to its new place and keeps
    // the fade and blur it was in the middle of.
    const onScreen = placement.visible || element.dataset.stageVisible !== undefined;
    if (remeasured && !instant && onScreen && element.dataset.stageRole === roles[index]) {
      if (previousY !== placement.y) snapStageElement(engine, element, placement.y);
      return;
    }
    if (unchanged && !instant) return;
    moves.push({
      element,
      placement,
      wasVisible,
      // A queued line rises from below the floor as it is now, never from where an older size put it.
      fromY:
        element.dataset.stageRole === "queued" && placement.visible
          ? queuedStageY(geometry.stageHeight, metrics[index].height, geometry.gap)
          : currentTranslateY(engine, element, previousY ?? placement.y),
      fromOpacity: Number(engine.window.getComputedStyle(element).opacity) || 0,
    });
  });
  const reduced = engine.window.matchMedia(REDUCED_MOTION_QUERY).matches;
  elements.forEach((element, index) => {
    if (element.dataset.stageRole !== roles[index]) element.dataset.stageRole = roles[index];
  });
  for (const move of moves) placeStageElement(engine, move, instant, reduced);
  if (!sameBox(box, engine.stageBox)) {
    engine.stageBox = box;
    engine.host.onStageLayout?.(box);
  }
}

import { CREDITS_CLASS } from "../constants";
import type { LineData } from "../inject";
import {
  layoutStage,
  planStage,
  queuedStageY,
  type StageBox,
  type StageItem,
  type StageMetrics,
  type StagePlacement,
  type StageSpanRect,
  stageTextSpan,
} from "../stage";
import { getCSSNumber } from "./cssValues";
import type { AnimationEngineInstance } from "./instance";
import { REDUCED_MOTION_QUERY } from "./motionPreference";

const STAGE_MOTION = { durationMs: 380, easing: "cubic-bezier(0.2, 0, 0, 1)" };
// Read by an important rule in stage.css, so a theme's own important opacity cannot reveal a line the stage
// is hiding or fading.
const STAGE_OPACITY_PROPERTY = "--blyrics-stage-opacity";
const STAGE_FADE_IN_MS = 300;
const STAGE_FADE_IN_DELAY_MS = 70;
const STAGE_FADE_OUT_MS = 220;
const HANDOFF_BLUR = "blur(3px)";
const STAGE_GAP_EM = 0.32;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const UNMEASURED: StageMetrics = { height: 0, left: 0, width: 0, originX: 0 };

const stageOpacityRegistrations = new WeakSet<object>();

interface StageMove {
  element: HTMLElement;
  placement: StagePlacement;
  wasVisible: boolean;
  fromY: number;
  fromOpacity: number;
}

interface StageGeometry {
  stageHeight: number;
  gap: number;
  activeScale: number;
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

  const metrics = elements.map(element => engine.stageMetrics.get(element) ?? UNMEASURED);
  const geometry: StageGeometry = {
    stageHeight: container.clientHeight,
    gap: engine.stageFontSize * STAGE_GAP_EM,
    activeScale: getCSSNumber(engine, container, "--blyrics-active-scale", 1),
  };
  const floorShift = remeasured && engine.stageHeight > 0 ? geometry.stageHeight - engine.stageHeight : 0;
  engine.stageHeight = geometry.stageHeight;
  const previousYs = elements.map(element => {
    const y = engine.stageY.get(element);
    return y === undefined ? null : y + floorShift;
  });
  const { placements, box } = layoutStage(roles, items, metrics, previousYs, geometry);

  const moves = prepareStageMoves(engine, elements, roles, placements, metrics, geometry, { remeasured, instant });
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

function prepareStageMoves(
  engine: AnimationEngineInstance,
  elements: HTMLElement[],
  roles: string[],
  placements: StagePlacement[],
  metrics: StageMetrics[],
  geometry: StageGeometry,
  { remeasured, instant }: { remeasured: boolean; instant: boolean }
): StageMove[] {
  const moves: StageMove[] = [];
  elements.forEach((element, index) => {
    const placement = placements[index];
    const role = element.dataset.stageRole;
    const previousY = engine.stageY.get(element);
    const wasVisible = role !== undefined && isStageRoleVisible(role);
    const onScreen = placement.visible || element.dataset.stageVisible !== undefined;
    if (remeasured && !instant && onScreen && role === roles[index]) {
      if (previousY !== placement.y) snapStageElement(engine, element, placement.y);
      return;
    }
    const unchanged =
      previousY !== undefined && wasVisible === placement.visible && (!placement.visible || previousY === placement.y);
    if (unchanged && !instant) return;

    const risesFromBelowFloor = role === "queued" && placement.visible;
    moves.push({
      element,
      placement,
      wasVisible,
      fromY: risesFromBelowFloor
        ? queuedStageY(geometry.stageHeight, metrics[index].height, geometry.gap)
        : currentTranslateY(engine, element, previousY ?? placement.y),
      fromOpacity: Number(engine.window.getComputedStyle(element).opacity) || 0,
    });
  });
  return moves;
}

function placeStageElement(
  engine: AnimationEngineInstance,
  { element, placement, wasVisible, fromY, fromOpacity }: StageMove,
  instant: boolean,
  reduced: boolean
): void {
  engine.stageMoves.get(element)?.cancel();
  engine.stageFades.get(element)?.cancel();
  engine.stageMoves.set(
    element,
    element.animate([{ translate: `0 ${fromY}px` }, { translate: `0 ${placement.y}px` }], {
      duration: instant || reduced ? 0 : STAGE_MOTION.durationMs,
      easing: STAGE_MOTION.easing,
      fill: "forwards",
    })
  );

  const showing = placement.visible;
  const fadeMs = instant ? 0 : showing ? STAGE_FADE_IN_MS : STAGE_FADE_OUT_MS;
  const delayMs = showing && !instant ? STAGE_FADE_IN_DELAY_MS : 0;
  if (showing) element.dataset.stageVisible = "";
  else if (fadeMs === 0) delete element.dataset.stageVisible;
  const fade = element.animate(
    [{ [STAGE_OPACITY_PROPERTY]: fromOpacity }, { [STAGE_OPACITY_PROPERTY]: showing ? 1 : 0 }],
    {
      duration: fadeMs,
      delay: delayMs,
      easing: showing ? "ease-out" : "ease",
      // Backwards fill preserves the sampled opacity during the replacement fade's delay.
      fill: "both",
    }
  );
  if (!showing && fadeMs > 0) {
    fade.onfinish = () => {
      if (engine.stageFades.get(element) === fade) delete element.dataset.stageVisible;
    };
  }
  engine.stageFades.set(element, fade);
  engine.stageY.set(element, placement.y);

  engine.stageBlurs.get(element)?.cancel();
  engine.stageBlurs.delete(element);
  if (fadeMs === 0 || reduced || wasVisible === showing) return;
  const blurs = showing ? [HANDOFF_BLUR, "none"] : ["none", HANDOFF_BLUR];
  engine.stageBlurs.set(
    element,
    element.animate(
      blurs.map(filter => ({ filter })),
      {
        duration: fadeMs,
        delay: showing ? STAGE_FADE_IN_DELAY_MS : 0,
        easing: showing ? "ease-out" : "ease",
        // Add to the theme's filter; release the blur once focused.
        composite: "add",
        fill: showing ? "backwards" : "forwards",
      }
    )
  );
}

function snapStageElement(engine: AnimationEngineInstance, element: HTMLElement, y: number): void {
  engine.stageMoves.get(element)?.cancel();
  engine.stageMoves.set(element, element.animate([{ translate: `0 ${y}px` }], { duration: 0, fill: "forwards" }));
  engine.stageY.set(element, y);
}

// Registered from script because Firefox was seen not to apply @property from this package's stylesheet
// when it loads cross-origin to the page. An unregistered property would snap instead of interpolating.
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

export function measureStage(engine: AnimationEngineInstance): void {
  engine.stageMetrics.clear();
  const container = engine.lyricsContainer;
  if (!container) return;
  engine.stageFontSize = Number.parseFloat(engine.window.getComputedStyle(container).fontSize) || 16;
  const range = engine.document.createRange();
  for (const element of stageElements(engine).elements) {
    const style = engine.window.getComputedStyle(element);
    const originX = originXOf(style.textAlign);
    const padding = {
      left: Number.parseFloat(style.paddingLeft) || 0,
      right: Number.parseFloat(style.paddingRight) || 0,
    };
    const contentRects = collectContentRects(engine, range, element, contentWidthOf(element, style), []);
    const span = stageTextSpan(
      element.offsetLeft,
      element.offsetWidth,
      element.getBoundingClientRect(),
      contentRects,
      padding,
      originX
    );
    engine.stageMetrics.set(element, { height: element.offsetHeight, left: span.left, width: span.width, originX });
  }
  forceStageReplan(engine);
  engine.stageRemeasured = true;
}

export function replaceStageElements(
  engine: AnimationEngineInstance,
  dropped: readonly LineData[],
  previousOf: ReadonlyMap<LineData, LineData>
): void {
  for (const [line, previous] of previousOf) carryStageState(engine, previous.lyricElement, line.lyricElement);
  for (const line of dropped) forgetStageElement(engine, line.lyricElement);
  forceStageReplan(engine);
}

function carryStageState(engine: AnimationEngineInstance, from: HTMLElement, to: HTMLElement): void {
  const role = from.dataset.stageRole;
  const y = engine.stageY.get(from);
  if (role === undefined || y === undefined) return;
  to.dataset.stageRole = role;
  if (from.dataset.stageVisible !== undefined) to.dataset.stageVisible = "";

  const move = continueAnimation(engine.stageMoves.get(from), to);
  if (move === null) {
    snapStageElement(engine, to, y);
  } else {
    engine.stageMoves.set(to, move);
    engine.stageY.set(to, y);
  }

  const visible = isStageRoleVisible(role);
  const fade =
    continueAnimation(engine.stageFades.get(from), to) ??
    to.animate([{ [STAGE_OPACITY_PROPERTY]: visible ? 1 : 0 }], { duration: 0, fill: "forwards" });
  if (!visible) {
    fade.onfinish = () => {
      if (engine.stageFades.get(to) === fade) delete to.dataset.stageVisible;
    };
  }
  engine.stageFades.set(to, fade);
  const blur = continueAnimation(engine.stageBlurs.get(from), to);
  if (blur !== null) engine.stageBlurs.set(to, blur);
}

function forgetStageElement(engine: AnimationEngineInstance, element: HTMLElement): void {
  for (const animations of [engine.stageMoves, engine.stageFades, engine.stageBlurs]) {
    animations.get(element)?.cancel();
    animations.delete(element);
  }
  engine.stageY.delete(element);
  engine.stageMetrics.delete(element);
}

export function resetStage(engine: AnimationEngineInstance): void {
  for (const animations of [engine.stageMoves, engine.stageFades, engine.stageBlurs]) {
    for (const animation of animations.values()) animation.cancel();
    animations.clear();
  }
  engine.stageMetrics.clear();
  engine.stageY.clear();
  forceStageReplan(engine);
  engine.stageHeight = 0;
  if (engine.stageBox !== null) {
    engine.stageBox = null;
    engine.host.onStageLayout?.(null);
  }
}

export function currentTranslateY(engine: AnimationEngineInstance, element: HTMLElement, fallback: number): number {
  const y = Number.parseFloat(engine.window.getComputedStyle(element).translate.split(" ")[1] ?? "");
  return Number.isFinite(y) ? y : fallback;
}

function forceStageReplan(engine: AnimationEngineInstance): void {
  engine.stageKey = "";
}

function continueAnimation(animation: Animation | undefined, element: HTMLElement): Animation | null {
  const effect = animation?.effect as KeyframeEffect | null | undefined;
  if (!animation || typeof effect?.getKeyframes !== "function") return null;
  if (animation.playState === "finished" || animation.playState === "idle") return null;
  const continued = element.animate(effect.getKeyframes(), { ...effect.getTiming(), composite: effect.composite });
  continued.playbackRate = animation.playbackRate;
  continued.currentTime = animation.currentTime;
  if (animation.playState === "paused") continued.pause();
  return continued;
}

function stageElements(engine: AnimationEngineInstance): { elements: HTMLElement[]; items: StageItem[] } {
  const elements: HTMLElement[] = [];
  const items: StageItem[] = [];
  let lastEnd = 0;
  for (const line of engine.lines) {
    const end = line.time + line.duration;
    lastEnd = Math.max(lastEnd, end);
    elements.push(line.lyricElement);
    items.push({ kind: stageItemKind(line.lyricElement), start: line.time, end });
  }
  const credits = engine.lyricsContainer?.querySelector<HTMLElement>(`:scope > .${CREDITS_CLASS}`);
  if (credits) {
    elements.push(credits);
    items.push({ kind: "credits", start: lastEnd, end: Number.POSITIVE_INFINITY });
  }
  return { elements, items };
}

function stageItemKind(element: HTMLElement): StageItem["kind"] {
  if (element.dataset.instrumental === "true") return "instrumental";
  if (element.dataset.blank === "true") return "blank";
  return "line";
}

function isStageRoleVisible(role: string): boolean {
  return role !== "queued" && role !== "gone";
}

function sameBox(a: StageBox | null, b: StageBox | null): boolean {
  if (a === null || b === null) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function originXOf(align: string): number {
  if (align === "center") return 0.5;
  if (align === "right" || align === "end") return 1;
  return 0;
}

function contentWidthOf(element: HTMLElement, style: CSSStyleDeclaration): number {
  const padding = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  return element.clientWidth - padding;
}

function fillsWidth(element: HTMLElement, contentWidth: number): boolean {
  return element.offsetWidth >= contentWidth - 1;
}

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
    if (style.display === "contents") collectContentRects(engine, range, element, contentWidth, rects);
    else if (style.display.startsWith("inline")) rects.push(...element.getClientRects());
    else if (!fillsWidth(element, contentWidth)) rects.push(element.getBoundingClientRect());
    else collectContentRects(engine, range, element, contentWidthOf(element, style), rects);
  }
  return rects;
}

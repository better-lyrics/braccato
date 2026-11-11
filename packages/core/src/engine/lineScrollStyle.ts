import { registerThemeSetting } from "../themeSettings";
import { toMs } from "../util";
import type { AnimationConfig } from "./animationConfig";
import type { AnimationEngineInstance } from "./instance";

export type LineScrollSide = "above" | "active" | "below";
type ScrollKeyframe = "start" | "end";

export interface LineScrollTiming {
  durationMs: number;
  startEasing: string;
  endEasing: string;
}

export interface StyledScrollLine {
  lineElement: HTMLElement;
  side: LineScrollSide;
}

interface SizedScrollLine extends StyledScrollLine {
  heightPx: number;
}

export interface ScrollVariables {
  index: number;
  activeIndex: number;
  relativeIndex: number;
  side: LineScrollSide;
  deltaPx: number;
}

const FALLBACK_DURATION_MS = 750;
const DEFAULT_TRAILING_DURATION =
  "calc(750ms + log(var(--blyrics-line-scroll-abs-relative-index) + 2, 2.71828) * 80ms + (var(--blyrics-line-scroll-abs-relative-index) + 1) * 20ms)";

function themeSetting(property: string, defaultValue: string) {
  return [property, registerThemeSetting(property.slice(2), defaultValue)] as const;
}

const THEME_SETTINGS = [
  themeSetting("--blyrics-line-scroll-duration", DEFAULT_TRAILING_DURATION),
  themeSetting(
    "--blyrics-line-scroll-above-duration",
    "calc(750ms + min(var(--blyrics-line-scroll-abs-relative-index), 6) * 20ms)"
  ),
  themeSetting("--blyrics-line-scroll-active-duration", ""),
  themeSetting("--blyrics-line-scroll-below-duration", DEFAULT_TRAILING_DURATION),
  themeSetting("--blyrics-line-scroll-timing-function", "var(--blyrics-lyric-scroll-timing-function)"),
  themeSetting("--blyrics-line-scroll-start-easing", "var(--blyrics-line-scroll-timing-function)"),
  themeSetting("--blyrics-line-scroll-end-easing", "linear"),
  themeSetting("--blyrics-line-scroll-above-start-easing", ""),
  themeSetting("--blyrics-line-scroll-active-start-easing", ""),
  themeSetting("--blyrics-line-scroll-below-start-easing", ""),
  themeSetting("--blyrics-line-scroll-above-end-easing", ""),
  themeSetting("--blyrics-line-scroll-active-end-easing", ""),
  themeSetting("--blyrics-line-scroll-below-end-easing", ""),
  themeSetting("--blyrics-line-scroll-translate-y-start", "var(--blyrics-line-scroll-delta-px)"),
  themeSetting("--blyrics-line-scroll-translate-y-end", "0px"),
  themeSetting("--blyrics-line-scroll-above-translate-y-start", ""),
  themeSetting("--blyrics-line-scroll-active-translate-y-start", ""),
  themeSetting("--blyrics-line-scroll-below-translate-y-start", ""),
  themeSetting("--blyrics-line-scroll-above-translate-y-end", ""),
  themeSetting("--blyrics-line-scroll-active-translate-y-end", ""),
  themeSetting("--blyrics-line-scroll-below-translate-y-end", ""),
] as const;

const TRANSLATE_SETTINGS = THEME_SETTINGS.filter(([property]) => property.includes("translate-y")).map(
  ([, setting]) => setting
);

const INDEX_PROPERTY = "--blyrics-line-scroll-index";
const ACTIVE_INDEX_PROPERTY = "--blyrics-line-scroll-active-index";
const RELATIVE_INDEX_PROPERTY = "--blyrics-line-scroll-relative-index";
const ABS_RELATIVE_INDEX_PROPERTY = "--blyrics-line-scroll-abs-relative-index";
const SIDE_PROPERTY = "--blyrics-line-scroll-side";
const DELTA_PROPERTY = "--blyrics-line-scroll-delta-px";
const DISTANCE_PROPERTY = "--blyrics-line-scroll-distance-px";

const INLINE_PROPERTIES = [
  INDEX_PROPERTY,
  ACTIVE_INDEX_PROPERTY,
  RELATIVE_INDEX_PROPERTY,
  ABS_RELATIVE_INDEX_PROPERTY,
  SIDE_PROPERTY,
  DELTA_PROPERTY,
  DISTANCE_PROPERTY,
  ...THEME_SETTINGS.map(([property]) => property),
];

export function themeOverridesScrollTranslate(): boolean {
  return TRANSLATE_SETTINGS.some(setting => setting.isManuallySet());
}

export function writeScrollVariables(lineElement: HTMLElement, variables: ScrollVariables): void {
  const style = lineElement.style;
  style.setProperty(INDEX_PROPERTY, String(variables.index));
  style.setProperty(ACTIVE_INDEX_PROPERTY, String(variables.activeIndex));
  style.setProperty(RELATIVE_INDEX_PROPERTY, String(variables.relativeIndex));
  style.setProperty(ABS_RELATIVE_INDEX_PROPERTY, String(Math.abs(variables.relativeIndex)));
  style.setProperty(SIDE_PROPERTY, variables.side);
  style.setProperty(DELTA_PROPERTY, `${variables.deltaPx}px`);
  style.setProperty(DISTANCE_PROPERTY, `${Math.abs(variables.deltaPx)}px`);
  for (const [property, setting] of THEME_SETTINGS) {
    const value = setting.getStringValue().trim();
    if (value) style.setProperty(property, value);
    else style.removeProperty(property);
  }
}

export function clearScrollVariables(lineElement: HTMLElement): void {
  for (const property of INLINE_PROPERTIES) lineElement.style.removeProperty(property);
}

function scrollVariable(name: string, side: LineScrollSide, differential: boolean, fallback: string): string {
  const shared = `var(--blyrics-line-scroll-${name}, ${fallback})`;
  return differential ? `var(--blyrics-line-scroll-${side}-${name}, ${shared})` : shared;
}

export function resolveScrollTimings(
  engine: AnimationEngineInstance,
  lines: StyledScrollLine[],
  { lineScroll }: AnimationConfig
): LineScrollTiming[] {
  const differential = lineScroll.differentialEffects;
  const durations = batchProbeComputedStyle(
    engine,
    lines,
    "transition-duration",
    line => scrollVariable("duration", line.side, differential, `${FALLBACK_DURATION_MS}ms`),
    style => {
      const durationMs = toMs(style.transitionDuration.split(",")[0].trim());
      return durationMs > 0 ? durationMs : FALLBACK_DURATION_MS;
    }
  );
  const easingsAt = (keyframe: ScrollKeyframe) =>
    batchProbeComputedStyle(
      engine,
      lines,
      "transition-timing-function",
      line =>
        scrollVariable(
          `${keyframe}-easing`,
          line.side,
          differential,
          `var(--blyrics-line-scroll-timing-function, ${lineScroll.easing})`
        ),
      style => style.transitionTimingFunction.trim() || lineScroll.easing
    );
  const startEasings = easingsAt("start");
  const endEasings = easingsAt("end");
  return lines.map((_, index) => ({
    durationMs: durations[index],
    startEasing: startEasings[index],
    endEasing: endEasings[index],
  }));
}

export function resolveThemedTranslates(
  engine: AnimationEngineInstance,
  lines: SizedScrollLine[],
  { lineScroll }: AnimationConfig
): { start: (number | null)[]; end: (number | null)[] } {
  const translatesAt = (keyframe: ScrollKeyframe) =>
    batchProbeComputedStyle(
      engine,
      lines,
      "translate",
      line => {
        const fallback = keyframe === "start" ? "var(--blyrics-line-scroll-delta-px, 0px)" : "0px";
        return `0 ${scrollVariable(`translate-y-${keyframe}`, line.side, lineScroll.differentialEffects, fallback)}`;
      },
      style => style.translate
    ).map((translate, index) => translateYPx(translate, lines[index].heightPx));
  return { start: translatesAt("start"), end: translatesAt("end") };
}

export function translateYPx(translate: string, heightPx: number): number | null {
  const value = translate.trim();
  if (value === "" || value === "none") return 0;
  const [, y = "0px"] = value.match(/calc\([^)]*\)|\S+/g) ?? [];
  const terms = y
    .replace(/^calc\((.*)\)$/, "$1")
    .replace(/\s+-\s+/g, " + -")
    .split(/\s+\+\s+/);
  let px = 0;
  for (const term of terms) {
    const length = term.trim().match(/^(-?[\d.]+(?:e-?\d+)?)(px|%)?$/);
    if (!length || (length[2] === undefined && Number(length[1]) !== 0)) return null;
    px += length[2] === "%" ? (Number(length[1]) * heightPx) / 100 : Number(length[1]);
  }
  return px;
}

function batchProbeComputedStyle<T>(
  engine: AnimationEngineInstance,
  lines: StyledScrollLine[],
  property: string,
  probeValue: (line: StyledScrollLine) => string,
  readValue: (style: CSSStyleDeclaration) => T
): T[] {
  const previous = lines.map(({ lineElement }) => ({
    value: lineElement.style.getPropertyValue(property),
    priority: lineElement.style.getPropertyPriority(property),
  }));
  for (const line of lines) line.lineElement.style.setProperty(property, probeValue(line), "important");

  const values = lines.map(line => readValue(engine.window.getComputedStyle(line.lineElement)));

  lines.forEach(({ lineElement }, index) => {
    const { value, priority } = previous[index];
    if (value) lineElement.style.setProperty(property, value, priority);
    else lineElement.style.removeProperty(property);
  });
  return values;
}

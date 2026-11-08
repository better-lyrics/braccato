import type { LineData } from "../inject";
import { clamp } from "../util";
import type { AnimationConfig } from "./animationConfig";
import { getCSSValue } from "./cssValues";
import type { AnimationEngineInstance } from "./instance";

const HALF_8BIT_ALPHA_STEP = 0.5 / 255;

// Keep var(--blyrics-glow-color) unresolved so each animated word supplies its color. Reading a composed
// filter from the container would bake in the container's color.
export function resolveGlowFilter(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  end: "from" | "to",
  defaultRadius: string
): string {
  const override = getCSSValue(engine, lyricsElement, `--blyrics-highlight-glow-filter-${end}`, "");
  if (override) return override;
  const radius = getCSSValue(engine, lyricsElement, `--blyrics-highlight-glow-radius-${end}`, defaultRadius);
  return `drop-shadow(0 0 ${radius} var(--blyrics-glow-color))`;
}

export function isGlowRestingInvisible(glowTo: string): boolean {
  const value = glowTo.trim();
  if (value === "" || value === "none") return true;
  const engineDropShadow = value.match(/^drop-shadow\(\s*0\s+0\s+(\S+)\s+var\(--blyrics-glow-color\)\)$/);
  return engineDropShadow ? Number.parseFloat(engineDropShadow[1]) === 0 : false;
}

export function suppressInvisibleWordGlows(
  engine: AnimationEngineInstance,
  line: LineData,
  config: AnimationConfig
): void {
  const containerGlowShows = config.highlight.glowContainerAlpha >= HALF_8BIT_ALPHA_STEP;
  if (containerGlowShows) {
    for (const part of line.parts) part.glowSuppressed = false;
    return;
  }
  for (const part of line.parts) {
    const color = engine.window.getComputedStyle(part.highlightElement).getPropertyValue("--blyrics-glow-color");
    const alpha = parseColorAlpha(color) ?? 1;
    part.glowSuppressed = alpha < HALF_8BIT_ALPHA_STEP;
  }
}

export function parseColorAlpha(value: string): number | null {
  const color = value.trim().toLowerCase();
  if (color === "") return null;
  if (color === "transparent") return 0;

  const slashAlpha = color.match(/\/\s*([0-9]*\.?[0-9]+%?)\s*\)\s*$/);
  if (slashAlpha) return alphaToken(slashAlpha[1]);

  const commaAlpha = color.match(/^(?:rgba|hsla)\([^)]*,\s*([0-9]*\.?[0-9]+%?)\s*\)$/);
  if (commaAlpha) return alphaToken(commaAlpha[1]);

  const hexWithAlpha = color.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);
  if (hexWithAlpha) {
    const digits = hexWithAlpha[1];
    const alphaHex = digits.length === 8 ? digits.slice(6) : digits.slice(3).repeat(2);
    return Number.parseInt(alphaHex, 16) / 255;
  }

  const opaqueFunction = /^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(color);
  const opaqueHex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color);
  const namedColor = /^[a-z]+$/.test(color);
  return opaqueFunction || opaqueHex || namedColor ? 1 : null;
}

function alphaToken(token: string): number {
  const value = token.endsWith("%") ? Number.parseFloat(token) / 100 : Number.parseFloat(token);
  return clamp(value, 0, 1);
}

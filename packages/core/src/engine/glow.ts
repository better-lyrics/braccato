import { clamp } from "../util";
import type { LineData } from "../inject";
import type { AnimationEngineInstance } from "./instance";
import type { AnimationConfig } from "./animationConfig";
import { getCSSValue } from "./cssValues";

// Compose the glow filter so the color stays an unresolved var(--blyrics-glow-color).
// Reading a fully composed --blyrics-highlight-glow-filter-* off the container resolves the
// nested color there, which would defeat per-word overrides like
// .blyrics--word[data-long-word] { --blyrics-glow-color: ... }. Building the filter here with
// the color left as a literal var lets the Web Animations API resolve it against each animated
// word instead. A theme that sets the full filter var still wins, but its color resolves once
// at the container (globally), as before.
// A glow whose resolved color falls below half a quantization step stays invisible even after the
// blur spreads it, so the per-frame drop-shadow can be skipped with no pixel changing.
const GLOW_INVISIBLE_ALPHA = 0.5 / 255;

function alphaToken(token: string): number {
  const value = token.endsWith("%") ? Number.parseFloat(token) / 100 : Number.parseFloat(token);
  return clamp(value, 0, 1);
}

// null for an unrecognized format, which the caller treats as opaque so a visible glow is never dropped.
export function parseColorAlpha(value: string): number | null {
  const color = value.trim().toLowerCase();
  if (color === "") return null;
  if (color === "transparent") return 0;

  const slashAlpha = color.match(/\/\s*([0-9]*\.?[0-9]+%?)\s*\)\s*$/);
  if (slashAlpha) return alphaToken(slashAlpha[1]);

  const commaAlpha = color.match(/^(?:rgba|hsla)\([^)]*,\s*([0-9]*\.?[0-9]+%?)\s*\)$/);
  if (commaAlpha) return alphaToken(commaAlpha[1]);

  const hex = color.match(/^#([0-9a-f]{4}|[0-9a-f]{8})$/);
  if (hex) {
    const digits = hex[1];
    const alphaHex = digits.length === 8 ? digits.slice(6) : digits.slice(3).repeat(2);
    return Number.parseInt(alphaHex, 16) / 255;
  }

  const opaqueFunction = /^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(color);
  const opaqueHex = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/.test(color);
  const namedColor = /^[a-z]+$/.test(color);
  if (opaqueFunction || opaqueHex || namedColor) return 1;
  return null;
}

// Per-word glow is resolved only when the container glow already renders nothing, so an empty word
// drops its blur while a word a theme lit up keeps it.
export function resolveLineGlowSuppression(
  engine: AnimationEngineInstance,
  lineData: LineData,
  config: AnimationConfig
): void {
  if (lineData.parts.some(part => part.imageLayers) || config.highlight.glowContainerAlpha >= GLOW_INVISIBLE_ALPHA) {
    for (const part of lineData.parts) part.glowSuppressed = false;
    return;
  }
  for (const part of lineData.parts) {
    const color = engine.window.getComputedStyle(part.highlightElement).getPropertyValue("--blyrics-glow-color");
    part.glowSuppressed = (parseColorAlpha(color) ?? 1) < GLOW_INVISIBLE_ALPHA;
  }
}

export function resolveGlowFilter(
  engine: AnimationEngineInstance,
  lyricsElement: HTMLElement,
  suffix: "from" | "to",
  radiusDefault: string
): string {
  const override = getCSSValue(engine, lyricsElement, `--blyrics-highlight-glow-filter-${suffix}`, "");
  if (override) return override;
  const radius = getCSSValue(engine, lyricsElement, `--blyrics-highlight-glow-radius-${suffix}`, radiusDefault);
  return `drop-shadow(0 0 ${radius} var(--blyrics-glow-color))`;
}

// Only the engine's own drop-shadow(0 0 <radius> ...) resting shape counts, so a theme override or a
// non-zero radius keeps its permanent glow on fill:forwards.
export function isGlowRestingInvisible(glowTo: string): boolean {
  const value = glowTo.trim();
  if (value === "" || value === "none") return true;
  const match = value.match(/^drop-shadow\(\s*0\s+0\s+(\S+)\s+var\(--blyrics-glow-color\)\)$/);
  return match ? Number.parseFloat(match[1]) === 0 : false;
}

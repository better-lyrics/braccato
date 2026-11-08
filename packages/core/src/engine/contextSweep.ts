import {
  BIDI_RUN_CLASS,
  HIGHLIGHT_RUN_CLASS,
  RTL_CLASS,
  SWEEP_CLONE_CLASS,
  SWEEP_CONTEXT_CLASS,
  SWEEP_TARGET_CLASS,
  SWEEP_WINDOW_CLASS,
  WORD_CLASS,
} from "../constants";
import { createSweepCell, type LineData, type PartData, type SweepCell, type SweepContext } from "../inject";
import type { AnimationConfig } from "./animationConfig";
import { swipeRamp } from "./letterPlans";
import { cellFade } from "./sweepPlans";

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Places the sweep cells of a line's inline words over the boxes those words are laid out in. Runs
 * when the line starts animating and reads layout first, so the reads land before the line's writes;
 * a word laid out as it was last time keeps its cells.
 */
export function placeContextSweeps(line: LineData, config: AnimationConfig): void {
  for (const part of line.parts) if (part.sweepContext) part.sweepContext.unplaced = true;
  const placements = line.parts.flatMap(part => (part.sweepContext ? [measure(part)] : []));
  for (const placement of placements) if (placement) place(placement, config);
}

interface Placement {
  part: PartData;
  context: SweepContext;
  contentLine: HTMLElement;
  run: HTMLElement;
  runBox: Box;
  fragments: Box[];
  colors: [string, string][];
  key: string;
}

// The cells sit outside the word, so they are handed the colours a theme may set on the word itself.
const WORD_COLORS = ["--blyrics-lyric-active-color", "--blyrics-glow-color"];

function measure(part: PartData): Placement | null {
  const word = part.lyricElement;
  const run = word.closest<HTMLElement>(`.${BIDI_RUN_CLASS}:not(.${HIGHLIGHT_RUN_CLASS})`);
  const contentLine = run?.parentElement;
  if (!run || !contentLine || !part.sweepContext || typeof word.getClientRects !== "function") return null;
  const lineRect = contentLine.getBoundingClientRect();
  // The line may be mid-scale, so boxes are read on screen and scaled back to the line's own pixels.
  const scale = contentLine.offsetWidth > 0 ? lineRect.width / contentLine.offsetWidth : 1;
  const local = (rect: DOMRect): Box => ({
    x: (rect.left - lineRect.left) / scale,
    y: (rect.top - lineRect.top) / scale,
    width: rect.width / scale,
    height: rect.height / scale,
  });
  const runBox = local(run.getBoundingClientRect());
  const fragments = Array.from(word.getClientRects(), local).filter(box => box.width > 0);
  // A line the browser skipped laying out has no boxes yet; it is placed once it comes into view.
  if (fragments.length === 0) return null;
  const style = word.ownerDocument.defaultView?.getComputedStyle(part.highlightElement);
  const colors = WORD_COLORS.map((name): [string, string] => [name, style?.getPropertyValue(name).trim() ?? ""]);
  const key = JSON.stringify([[runBox, fragments].flat().map(box => Object.values(box).map(Math.round)), colors]);
  return { part, context: part.sweepContext, contentLine, run, runBox, fragments, colors, key };
}

/** Whether a line started before its inline words could be placed, and has to start over to show them. */
export function hasUnplacedContextSweeps(line: LineData): boolean {
  return line.isAnimating && line.parts.some(part => part.sweepContext?.unplaced);
}

function place(
  { part, context, contentLine, run, runBox, fragments, colors, key }: Placement,
  config: AnimationConfig
): void {
  const placedAt = key + JSON.stringify(swipeRamp(config));
  if (context.placedAt === placedAt && context.host?.isConnected) {
    context.unplaced = false;
    return;
  }
  context.host?.remove();
  const doc = contentLine.ownerDocument;
  const host = doc.createElement("span");
  host.classList.add(SWEEP_CONTEXT_CLASS);
  host.setAttribute("aria-hidden", "true");
  for (const [name, value] of colors) if (value) host.style.setProperty(name, value);

  const wordIndex = Array.from(run.querySelectorAll(`.${WORD_CLASS}`)).indexOf(part.lyricElement);
  const lineCopy = run.cloneNode(true) as HTMLElement;
  lineCopy.classList.add(SWEEP_CLONE_CLASS);
  lineCopy.querySelectorAll(`.${WORD_CLASS}`)[wordIndex]?.classList.add(SWEEP_TARGET_CLASS);

  const wordWidth = fragments.reduce((sum, box) => sum + box.width, 0);
  const direction = part.lyricElement.classList.contains(RTL_CLASS) ? "rtl" : "ltr";
  let start = 0;
  const cells: SweepCell[] = fragments.map(box => {
    const window = doc.createElement("span");
    window.classList.add(SWEEP_WINDOW_CLASS);
    window.dir = direction;
    Object.assign(window.style, {
      left: `${box.x}px`,
      top: `${box.y}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    const span = { start: start / wordWidth, width: box.width / wordWidth };
    start += box.width;
    window.style.setProperty("--blyrics-sweep-fade", String(cellFade(swipeRamp(config), span)));
    const cell = createSweepCell(doc, window);
    for (const pair of [cell, ...cell.glows]) {
      const copy = lineCopy.cloneNode(true) as HTMLElement;
      Object.assign(copy.style, {
        left: `${runBox.x - box.x}px`,
        top: `${runBox.y - box.y}px`,
        width: `${runBox.width}px`,
      });
      pair.text.appendChild(copy);
    }
    host.appendChild(window);
    return { ...cell, span };
  });

  contentLine.appendChild(host);
  context.host = host;
  context.placedAt = placedAt;
  context.unplaced = false;
  part.sweep = cells.length > 0 ? cells : undefined;
}

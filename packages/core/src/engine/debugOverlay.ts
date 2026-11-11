import type { LineData } from "../inject";
import { registerThemeSetting } from "../themeSettings";
import type { AnimationEngineInstance } from "./instance";

const DEBUG_OVERLAY_ENABLED = registerThemeSetting("blyrics-debug-renderer", false);
const GUIDE_START_X = 40;
const GUIDE_END_X = 1000;
const LAST_SCROLL_COLUMN_X = 160;

export interface ScrollDebugFrame {
  lyricsElement: HTMLElement;
  scrollTop: number;
  viewportHeight: number;
  targetOffset: number;
  followedLines: LineData[];
  lineCenters: number[];
  scrollTimeS: number;
  endingThresholdS: number;
}

export function isDebugOverlayEnabled(): boolean {
  return DEBUG_OVERLAY_ENABLED.getBooleanValue();
}

export function drawScrollDebugOverlay(engine: AnimationEngineInstance, frame: ScrollDebugFrame): void {
  const transform = engine.window.getComputedStyle(frame.lyricsElement).transform;
  const viewTop = frame.scrollTop - new engine.window.DOMMatrix(transform).f;
  const ctx = engine.host.debug?.beginFrame(viewTop);
  if (!ctx) return;

  const guide = (color: string, label: string, y: number) => {
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.fillText(label, 0, y);
    ctx.beginPath();
    ctx.moveTo(GUIDE_START_X, y);
    ctx.lineTo(GUIDE_END_X, y);
    ctx.stroke();
  };
  guide("green", "visible top", frame.scrollTop);
  guide("blue", "visible bottom", frame.scrollTop + frame.viewportHeight);
  guide("yellow", "target", frame.scrollTop + frame.targetOffset);

  const last = engine.lastScrollDebugContext;
  drawLineColumn(ctx, viewTop, 0, "realtime", frame.followedLines, frame.lineCenters, frame.scrollTimeS, frame);
  drawLineColumn(
    ctx,
    viewTop,
    LAST_SCROLL_COLUMN_X,
    "last scroll",
    last.activeElms,
    last.centers,
    last.lyricScrollTime,
    frame
  );
}

function drawLineColumn(
  ctx: CanvasRenderingContext2D,
  viewTop: number,
  x: number,
  title: string,
  lines: LineData[],
  centers: number[],
  scrollTimeS: number,
  { endingThresholdS }: ScrollDebugFrame
): void {
  ctx.strokeStyle = "red";
  ctx.fillStyle = "red";
  ctx.fillText(title, x + 2, viewTop + 45);
  ctx.fillText(`scroll time: ${scrollTimeS.toFixed(3)}`, x + 2, viewTop + 60);

  for (const line of lines) {
    const untilStartS = line.time - scrollTimeS;
    const endS = line.time + line.duration;
    const untilEndS = endS - scrollTimeS;
    const color = untilEndS < endingThresholdS ? "gray" : untilStartS > 0 ? "magenta" : "orange";
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + 5, line.position);
    ctx.lineTo(x + 5, line.position + line.height);
    ctx.stroke();
    ctx.fillText(`time: start=${line.time.toFixed(2)} end=${endS.toFixed(2)}`, x + 15, line.position);
    ctx.fillText(`till active: ${untilStartS.toFixed(2)}`, x + 15, line.position + 15);
    ctx.fillText(`till end: ${untilEndS.toFixed(2)}`, x + 15, line.position + 30);
  }

  ctx.strokeStyle = "pink";
  ctx.fillStyle = "pink";
  for (const center of centers) {
    ctx.beginPath();
    ctx.arc(x + 5, center, 5, 0, 2 * Math.PI, false);
    ctx.fill();
  }
}

import { detectFormat } from "@braccato/parsers/format";
import { changedRange, lineText, sameTokens, splitLines } from "./lines.js";
import {
	EVERYTHING,
	NOTHING,
	type StyleWindow,
	firstIndex,
	projectLine,
	shiftWindow,
	visibleWindow,
} from "./styleWindow.js";
import { type PaintedToken, tokenPainter } from "./tokenHighlights.js";
import { tokenize } from "./tokenize.js";
import type { LyricFormat, Token } from "./types.js";

export const SYNCED_BOX_PROPERTIES = [
	"font-family",
	"font-size",
	"font-weight",
	"font-style",
	"font-stretch",
	"font-variant",
	"font-feature-settings",
	"font-kerning",
	"line-height",
	"letter-spacing",
	"word-spacing",
	"tab-size",
	"direction",
	"text-align",
	"text-indent",
	"text-transform",
	"word-break",
	"overflow-wrap",
	"box-sizing",
	"padding-top",
	"padding-right",
	"padding-bottom",
	"padding-left",
	"border-top-width",
	"border-right-width",
	"border-bottom-width",
	"border-left-width",
] as const;

export function layerText(src: string): string {
	return src.endsWith("\n") ? `${src} ` : src;
}

export interface EditorOptions {
	/**
	 * Fixed format; omitted means detect on every render so pasting a different format re-colours.
	 * Read once at attach time: later writes to this object are ignored. Change it with `EditorHandle.setFormat`.
	 */
	format?: LyricFormat;
}

export interface EditorHandle {
	wrap: HTMLElement;
	layer: HTMLElement;
	/** Re-renders from `textarea.value`. Call it after every programmatic write, which fires no `input` event. */
	refresh(): void;
	/**
	 * Changes the fixed format of the live editor without re-attaching, so the textarea keeps its native undo
	 * history. `undefined` goes back to detecting the format on every render. Re-renders at once; does nothing
	 * when the format is unchanged or the editor is destroyed. It does not replace `refresh()` after a
	 * programmatic write to `textarea.value`.
	 */
	setFormat(format?: LyricFormat): void;
	destroy(): void;
}

/** Layer heights styled above and below the visible box. Scrolling past a quarter of that restyles once scrolling settles; past all of it, at once. */
const WINDOW_MARGIN = 1;
const WINDOW_SLACK = 0.25;
const SETTLE_MS = 150;
/** Edits that change the length by more than this share of the styled range in total can pull unstyled text into view. */
const REMEASURE_SHARE = 0.125;

const attached = new WeakMap<HTMLTextAreaElement, EditorHandle>();

/**
 * Lays a highlighted layer under `textarea`. The editor copies `options` at attach time and owns its format from
 * then on. Attaching a textarea that already has a live editor returns that handle and ignores the new
 * `options`; call `setFormat` on the handle to change the format.
 */
export function attachEditor(textarea: HTMLTextAreaElement, options: EditorOptions = {}): EditorHandle {
	const existing = attached.get(textarea);
	if (existing) return existing;
	let format = options.format;
	const doc = textarea.ownerDocument;
	const view = doc.defaultView;
	if (!view) throw new Error("attachEditor needs a textarea in a document with a window");
	if (!textarea.parentNode)
		throw new Error("attachEditor needs a textarea that is already in the DOM (it has no parent)");
	const wrap = doc.createElement("div");
	wrap.className = "bh-edit";
	const layer = doc.createElement("pre");
	layer.className = "bh bh-layer";
	layer.setAttribute("aria-hidden", "true");
	textarea.before(wrap);
	wrap.append(layer, textarea);
	const addedInputClass = !textarea.classList.contains("bh-input");
	textarea.classList.add("bh-input");

	const boxValues = new Map<string, string>();
	const typedStyle = typeof textarea.computedStyleMap === "function" ? textarea.computedStyleMap() : null;
	const syncBox = (): boolean => {
		const computed = view.getComputedStyle(textarea);
		let changed = false;
		for (const prop of SYNCED_BOX_PROPERTIES) {
			// Blink floors a unitless line-height to 1/64px but rounds a px one, so copying the px drifts every row.
			const value = (prop === "line-height" && typedStyle?.get(prop)?.toString()) || computed.getPropertyValue(prop);
			if (boxValues.get(prop) === value) continue;
			boxValues.set(prop, value);
			layer.style.setProperty(prop, value);
			changed = true;
		}
		const dir = textarea.getAttribute("dir");
		if (dir === layer.getAttribute("dir")) return changed;
		if (dir === null) layer.removeAttribute("dir");
		else layer.setAttribute("dir", dir);
		return true;
	};
	const boxPx = (prop: string) => Number.parseFloat(boxValues.get(prop) ?? "") || 0;
	const insets = new Map<string, number>();
	const setInset = (side: "left" | "right" | "bottom", value: number) => {
		if ((insets.get(side) ?? 0) === value) return;
		insets.set(side, value);
		layer.style.setProperty(side, `${value}px`);
	};
	// A classic scrollbar comes out of the textarea's content box; the layer has none, so it gives up the same strip.
	const syncGutters = (entry: ResizeObserverEntry | undefined) => {
		const border = entry?.borderBoxSize?.[0];
		const content = entry?.contentBoxSize?.[0];
		if (!border || !content) return;
		if (view.getComputedStyle(textarea).getPropertyValue("writing-mode") !== "horizontal-tb") {
			for (const side of ["left", "right", "bottom"] as const) setInset(side, 0);
			return;
		}
		const frame = (a: string, b: string) =>
			boxPx(`padding-${a}`) + boxPx(`padding-${b}`) + boxPx(`border-${a}-width`) + boxPx(`border-${b}-width`);
		const snap = (px: number) => Math.max(0, Math.round(px * 64) / 64);
		const inline = snap(border.inlineSize - content.inlineSize - frame("left", "right"));
		const block = snap(border.blockSize - content.blockSize - frame("top", "bottom"));
		// clientLeft is a rounded integer while borders can be fractional, so a sub-pixel remainder is rounding, not gutter.
		const leftRaw = inline > 0 ? snap(Math.min(inline, textarea.clientLeft - boxPx("border-left-width"))) : 0;
		const left = leftRaw < 1 ? 0 : inline - leftRaw < 1 ? inline : leftRaw;
		setInset("left", left);
		setInset("right", inline - left);
		setInset("bottom", block);
	};
	let scrolledTo = 0;
	const syncScroll = () => {
		scrolledTo = textarea.scrollTop;
		layer.scrollTop = scrolledTo;
		layer.scrollLeft = textarea.scrollLeft;
	};
	let editedSinceMeasure = 0;
	let lines: Token[][] = [];
	let shown: (readonly Token[])[] = [];
	let starts: number[] = [];
	let lineEls: HTMLElement[] = [];
	let lineTexts: Text[] = [];
	let painted: PaintedToken[][] = [];
	let source = "";
	let styled = EVERYTHING;
	const painter = tokenPainter(view);
	const paintLine = (index: number) => {
		if (!painter) return;
		painter.clear(painted[index]);
		painted[index] = painter.paint(lineTexts[index], shown[index]);
	};
	const replaceLines = (start: number, prevEnd: number, nextEnd: number) => {
		for (let k = start; k < prevEnd; k++) painter?.clear(painted[k]);
		const tokens = lines.slice(start, nextEnd).map((line, k) => projectLine(line, starts[start + k], styled));
		const texts = lines.slice(start, nextEnd).map((line) => doc.createTextNode(lineText(line)));
		const els = texts.map((text) => {
			const el = doc.createElement("span");
			el.className = "bh-line";
			el.append(text);
			return el;
		});
		const fragment = doc.createDocumentFragment();
		for (const el of els) fragment.append(el);
		for (const el of lineEls.slice(start, prevEnd)) el.remove();
		layer.insertBefore(fragment, lineEls[prevEnd] ?? null);
		lineEls = lineEls.slice(0, start).concat(els, lineEls.slice(prevEnd));
		lineTexts = lineTexts.slice(0, start).concat(texts, lineTexts.slice(prevEnd));
		shown = shown.slice(0, start).concat(tokens, shown.slice(prevEnd));
		painted = painted.slice(0, start).concat(
			texts.map((text, k) => painter?.paint(text, tokens[k]) ?? []),
			painted.slice(prevEnd),
		);
	};
	const clearPaint = () => {
		for (const line of painted) painter?.clear(line);
		painted = [];
	};
	// A whole-string data write measured faster than replaceData in Blink.
	const patchLine = (index: number) => {
		const text = lineText(lines[index]);
		const textChanged = lineTexts[index].data !== text;
		if (textChanged) lineTexts[index].data = text;
		restyleLine(index, textChanged);
	};
	const restyleLine = (index: number, textChanged = false) => {
		const prev = shown[index];
		const tokens = projectLine(lines[index], starts[index], styled);
		shown[index] = tokens;
		if (!textChanged && (tokens === prev || sameTokens(prev, tokens))) return;
		paintLine(index);
	};
	const lineStarts = (next: Token[][]) => {
		const out: number[] = [];
		let at = 0;
		for (const line of next) {
			out.push(at);
			for (const token of line) at += token.text.length;
		}
		return out;
	};
	const render = (full: boolean) => {
		if (full) boxValues.clear();
		const boxChanged = syncBox();
		const src = textarea.value;
		const text = layerText(src);
		const next = splitLines(tokenize(text, format ?? detectFormat(src)));
		const prevLines = lines;
		const prevLength = source.length;
		if (!full) styled = shiftWindow(styled, source, text);
		lines = next;
		starts = lineStarts(next);
		source = text;
		if (full) {
			clearPaint();
			lineEls = [];
			lineTexts = [];
			shown = [];
			layer.replaceChildren();
			replaceLines(0, 0, next.length);
		} else {
			const { start, prevEnd, nextEnd } = changedRange(prevLines, next);
			if (prevEnd - start === nextEnd - start) for (let k = start; k < prevEnd; k++) patchLine(k);
			else replaceLines(start, prevEnd, nextEnd);
		}
		if (full) syncScroll();
		editedSinceMeasure += Math.abs(text.length - prevLength);
		if (
			full ||
			boxChanged ||
			!Number.isFinite(styled.to) ||
			next.length !== prevLines.length ||
			editedSinceMeasure > (styled.to - styled.from) * REMEASURE_SHARE
		)
			scheduleRestyle();
	};
	const lineAt = (offset: number) => Math.max(0, firstIndex(starts.length, (k) => starts[k] > offset) - 1);
	const linesIn = ({ from, to }: StyleWindow) => [lineAt(from), lineAt(Math.max(from, to - 1))];
	const rendered = () => ({ layer, lineEls, lineTexts, starts, length: source.length });
	let measuredAt = Number.NaN;
	let settle = 0;
	// Restyling relays out the rest of a long line, so while the visible text is still styled it waits for scrolling to stop.
	const restyle = (urgentOnly: boolean) => {
		const height = layer.clientHeight;
		if (!height) return;
		const drift = Number.isNaN(measuredAt) ? Number.POSITIVE_INFINITY : Math.abs(scrolledTo - measuredAt);
		if (drift <= height * WINDOW_SLACK) return;
		if (urgentOnly && drift < height * WINDOW_MARGIN) {
			view.clearTimeout(settle);
			settle = view.setTimeout(() => restyle(false), SETTLE_MS);
			return;
		}
		const prev = styled;
		styled = visibleWindow(rendered(), WINDOW_MARGIN);
		measuredAt = Number.isFinite(styled.to) ? scrolledTo : Number.NaN;
		editedSinceMeasure = 0;
		if (lines.length === 0) return;
		const [prevFirst, prevLast] = linesIn(prev);
		const [first, last] = linesIn(styled);
		for (let k = prevFirst; k <= prevLast; k++) restyleLine(k);
		for (let k = Math.max(first, prevLast + 1); k <= last; k++) restyleLine(k);
		for (let k = first; k <= Math.min(last, prevFirst - 1); k++) restyleLine(k);
	};
	let frame = 0;
	const scheduleRestyle = () => {
		measuredAt = Number.NaN;
		if (!frame)
			frame = view.requestAnimationFrame(() => {
				frame = 0;
				restyle(true);
			});
	};
	let destroyed = false;
	const refresh = () => {
		if (!destroyed) render(true);
	};
	const update = () => render(false);
	const onScroll = () => {
		syncScroll();
		restyle(true);
	};
	const onResize = (entries: ResizeObserverEntry[]) => {
		syncBox();
		syncGutters(entries[entries.length - 1]);
		measuredAt = Number.NaN;
		restyle(false);
	};

	const resize = new view.ResizeObserver(onResize);
	resize.observe(textarea);
	textarea.addEventListener("input", update);
	textarea.addEventListener("scroll", onScroll, { passive: true });
	doc.fonts?.addEventListener("loadingdone", scheduleRestyle);
	if (layer.clientHeight) styled = NOTHING;
	refresh();

	const handle: EditorHandle = {
		wrap,
		layer,
		refresh,
		setFormat(next) {
			if (destroyed || next === format) return;
			format = next;
			render(false);
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			attached.delete(textarea);
			resize.disconnect();
			view.cancelAnimationFrame(frame);
			view.clearTimeout(settle);
			clearPaint();
			textarea.removeEventListener("input", update);
			textarea.removeEventListener("scroll", onScroll);
			doc.fonts?.removeEventListener("loadingdone", scheduleRestyle);
			if (addedInputClass) textarea.classList.remove("bh-input");
			wrap.before(textarea);
			wrap.remove();
		},
	};
	attached.set(textarea, handle);
	return handle;
}

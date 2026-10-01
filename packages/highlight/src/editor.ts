import { detectFormat } from "@braccato/parsers/format";
import { changedRange, changedTokens, matchByOffset, splitLines } from "./lines.js";
import { mergeTokens, tokenNode } from "./render.js";
import {
	EVERYTHING,
	NOTHING,
	type StyleWindow,
	firstIndex,
	projectLine,
	shiftWindow,
	visibleWindow,
} from "./styleWindow.js";
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
	/** Fixed format; omitted means detect on every render so pasting a different format re-colours. */
	format?: LyricFormat;
}

export interface EditorHandle {
	wrap: HTMLElement;
	layer: HTMLElement;
	refresh(): void;
	destroy(): void;
}

/** Layer heights styled above and below the visible box. Scrolling past a quarter of that restyles once scrolling settles; past all of it, at once. */
const WINDOW_MARGIN = 1;
const WINDOW_SLACK = 0.25;
const SETTLE_MS = 150;
/** Edits that change the length by more than this share of the styled range in total can pull unstyled text into view. */
const REMEASURE_SHARE = 0.125;

const attached = new WeakMap<HTMLTextAreaElement, EditorHandle>();

/** Attaching the same textarea twice returns the handle that is already live, whatever the options. */
export function attachEditor(textarea: HTMLTextAreaElement, options: EditorOptions = {}): EditorHandle {
	const existing = attached.get(textarea);
	if (existing) return existing;
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
	const syncBox = (): boolean => {
		const computed = view.getComputedStyle(textarea);
		let changed = false;
		for (const prop of SYNCED_BOX_PROPERTIES) {
			const value = computed.getPropertyValue(prop);
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
	let lineNodes: ChildNode[][] = [];
	let source = "";
	let styled = EVERYTHING;
	const splice = <T extends ChildNode>(parent: Node, nodes: T[], start: number, end: number, fresh: T[]): T[] => {
		const fragment = doc.createDocumentFragment();
		for (const node of fresh) fragment.append(node);
		for (const node of nodes.slice(start, end)) node.remove();
		parent.insertBefore(fragment, nodes[end] ?? null);
		return nodes.slice(0, start).concat(fresh, nodes.slice(end));
	};
	const replaceLines = (start: number, prevEnd: number, nextEnd: number) => {
		const tokens = lines.slice(start, nextEnd).map((line, k) => projectLine(line, starts[start + k], styled));
		const nodes = tokens.map((line) => line.map((token) => tokenNode(doc, token)));
		const els = nodes.map((line) => {
			const el = doc.createElement("span");
			el.className = "bh-line";
			for (const node of line) el.append(node);
			return el;
		});
		lineEls = splice(layer, lineEls, start, prevEnd, els);
		lineNodes = lineNodes.slice(0, start).concat(nodes, lineNodes.slice(prevEnd));
		shown = shown.slice(0, start).concat(tokens, shown.slice(prevEnd));
	};
	// Unchanged nodes keep their shaping in Blink; a whole-string data write measured faster than replaceData.
	const patchLine = (index: number) => {
		const prev = shown[index];
		const tokens = projectLine(lines[index], starts[index], styled);
		shown[index] = tokens;
		if (tokens === prev) return;
		const nodes = lineNodes[index];
		const { start, prevEnd, nextEnd } = changedTokens(prev, tokens);
		if (start === prevEnd && start === nextEnd) return;
		if (prevEnd - start === 1 && nextEnd - start === 1 && prev[start].type === tokens[start].type) {
			const node = nodes[start];
			const text = (prev[start].type === "text" ? node : node.firstChild) as Text;
			text.data = tokens[start].text;
			return;
		}
		const fresh = tokens.slice(start, nextEnd).map((token) => tokenNode(doc, token));
		lineNodes[index] = splice(lineEls[index], nodes, start, prevEnd, fresh);
	};
	// Restyling never changes the text, so nodes are matched by offset and only the tokens entering or leaving the window change.
	const restyleLine = (index: number) => {
		const prev = shown[index];
		const tokens = projectLine(lines[index], starts[index], styled);
		if (tokens === prev) return;
		shown[index] = tokens;
		const nodes = lineNodes[index];
		const matched = matchByOffset(prev, tokens);
		const kept = new Uint8Array(prev.length);
		for (const i of matched) if (i >= 0) kept[i] = 1;
		for (let i = 0; i < prev.length; i++) if (!kept[i]) nodes[i].remove();
		const next: ChildNode[] = new Array(tokens.length);
		let after: ChildNode | null = null;
		for (let j = tokens.length - 1; j >= 0; j--) {
			const i = matched[j];
			if (i < 0) {
				next[j] = lineEls[index].insertBefore(tokenNode(doc, tokens[j]), after);
			} else {
				next[j] = nodes[i];
				if (prev[i].text !== tokens[j].text)
					((tokens[j].type === "text" ? nodes[i] : nodes[i].firstChild) as Text).data = tokens[j].text;
			}
			after = next[j];
		}
		lineNodes[index] = next;
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
		const next = splitLines(mergeTokens(tokenize(text, options.format ?? detectFormat(src))));
		const prevLines = lines;
		const prevLength = source.length;
		if (!full) styled = shiftWindow(styled, source, text);
		lines = next;
		starts = lineStarts(next);
		source = text;
		if (full) {
			lineEls = [];
			lineNodes = [];
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
	const rendered = () => ({ layer, lineEls, lineNodes, shown, starts, length: source.length });
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
	const onResize = () => {
		syncBox();
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
		destroy() {
			if (destroyed) return;
			destroyed = true;
			attached.delete(textarea);
			resize.disconnect();
			view.cancelAnimationFrame(frame);
			view.clearTimeout(settle);
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

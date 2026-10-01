import { detectFormat } from "@braccato/parsers/format";
import { changedRange, changedTokens, splitLines } from "./lines.js";
import { mergeTokens, tokenNode } from "./render.js";
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
	const syncBox = () => {
		const computed = view.getComputedStyle(textarea);
		for (const prop of SYNCED_BOX_PROPERTIES) {
			const value = computed.getPropertyValue(prop);
			if (boxValues.get(prop) === value) continue;
			boxValues.set(prop, value);
			layer.style.setProperty(prop, value);
		}
		const dir = textarea.getAttribute("dir");
		if (dir === layer.getAttribute("dir")) return;
		if (dir === null) layer.removeAttribute("dir");
		else layer.setAttribute("dir", dir);
	};
	const syncScroll = () => {
		layer.scrollTop = textarea.scrollTop;
		layer.scrollLeft = textarea.scrollLeft;
	};
	let lines: Token[][] = [];
	let lineEls: HTMLElement[] = [];
	let lineNodes: ChildNode[][] = [];
	const splice = <T extends ChildNode>(parent: Node, nodes: T[], start: number, end: number, fresh: T[]): T[] => {
		const fragment = doc.createDocumentFragment();
		for (const node of fresh) fragment.append(node);
		for (const node of nodes.slice(start, end)) node.remove();
		parent.insertBefore(fragment, nodes[end] ?? null);
		return nodes.slice(0, start).concat(fresh, nodes.slice(end));
	};
	const replaceLines = (start: number, prevEnd: number, tokens: Token[][]) => {
		const nodes = tokens.map((line) => line.map((token) => tokenNode(doc, token)));
		const els = nodes.map((line) => {
			const el = doc.createElement("span");
			el.className = "bh-line";
			for (const node of line) el.append(node);
			return el;
		});
		lineEls = splice(layer, lineEls, start, prevEnd, els);
		lineNodes = lineNodes.slice(0, start).concat(nodes, lineNodes.slice(prevEnd));
	};
	// Unchanged nodes keep their shaping in Blink; a whole-string data write measured faster than replaceData.
	const patchLine = (index: number, tokens: Token[]) => {
		const prev = lines[index];
		const nodes = lineNodes[index];
		const { start, prevEnd, nextEnd } = changedTokens(prev, tokens);
		if (prevEnd - start === 1 && nextEnd - start === 1 && prev[start].type === tokens[start].type) {
			const node = nodes[start];
			const text = (prev[start].type === "text" ? node : node.firstChild) as Text;
			text.data = tokens[start].text;
			return;
		}
		const fresh = tokens.slice(start, nextEnd).map((token) => tokenNode(doc, token));
		lineNodes[index] = splice(lineEls[index], nodes, start, prevEnd, fresh);
	};
	const render = (full: boolean) => {
		if (full) boxValues.clear();
		syncBox();
		const src = textarea.value;
		const next = splitLines(mergeTokens(tokenize(layerText(src), options.format ?? detectFormat(src))));
		if (full) {
			lineEls = [];
			lineNodes = [];
			layer.replaceChildren();
			replaceLines(0, 0, next);
		} else {
			const { start, prevEnd, nextEnd } = changedRange(lines, next);
			if (prevEnd - start === nextEnd - start) for (let k = start; k < prevEnd; k++) patchLine(k, next[k]);
			else replaceLines(start, prevEnd, next.slice(start, nextEnd));
		}
		lines = next;
		if (full) syncScroll();
	};
	const refresh = () => render(true);
	const update = () => render(false);

	const resize = new view.ResizeObserver(syncBox);
	resize.observe(textarea);
	textarea.addEventListener("input", update);
	textarea.addEventListener("scroll", syncScroll, { passive: true });
	refresh();

	let destroyed = false;
	const handle: EditorHandle = {
		wrap,
		layer,
		refresh,
		destroy() {
			if (destroyed) return;
			destroyed = true;
			attached.delete(textarea);
			resize.disconnect();
			textarea.removeEventListener("input", update);
			textarea.removeEventListener("scroll", syncScroll);
			if (addedInputClass) textarea.classList.remove("bh-input");
			wrap.before(textarea);
			wrap.remove();
		},
	};
	attached.set(textarea, handle);
	return handle;
}

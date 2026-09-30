import { detectFormat } from "@braccato/parsers/format";
import { changedRange, splitLines } from "./lines.js";
import { appendTokens, mergeTokens } from "./render.js";
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

	const syncBox = () => {
		const computed = view.getComputedStyle(textarea);
		for (const prop of SYNCED_BOX_PROPERTIES) layer.style.setProperty(prop, computed.getPropertyValue(prop));
		const dir = textarea.getAttribute("dir");
		if (dir === null) layer.removeAttribute("dir");
		else layer.setAttribute("dir", dir);
	};
	const syncScroll = () => {
		layer.scrollTop = textarea.scrollTop;
		layer.scrollLeft = textarea.scrollLeft;
	};
	let lines: Token[][] = [];
	let lineEls: HTMLElement[] = [];
	const lineElement = (tokens: Token[]) => {
		const el = doc.createElement("span");
		el.className = "bh-line";
		appendTokens(el, tokens);
		return el;
	};
	const render = (full: boolean) => {
		syncBox();
		const src = textarea.value;
		const next = splitLines(mergeTokens(tokenize(layerText(src), options.format ?? detectFormat(src))));
		const { start, prevEnd, nextEnd } = full
			? { start: 0, prevEnd: lines.length, nextEnd: next.length }
			: changedRange(lines, next);
		const fresh = next.slice(start, nextEnd).map(lineElement);
		const fragment = doc.createDocumentFragment();
		for (const el of fresh) fragment.append(el);
		if (full) layer.replaceChildren(fragment);
		else {
			for (const el of lineEls.slice(start, prevEnd)) el.remove();
			const anchor = lineEls[prevEnd];
			if (anchor) anchor.before(fragment);
			else layer.append(fragment);
		}
		lineEls = [...lineEls.slice(0, start), ...fresh, ...lineEls.slice(prevEnd)];
		lines = next;
		syncScroll();
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

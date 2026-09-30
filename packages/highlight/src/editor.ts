import { detectFormat } from "@braccato/parsers/format";
import { highlightInto } from "./render.js";
import type { LyricFormat } from "./types.js";

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
	const refresh = () => {
		syncBox();
		const src = textarea.value;
		highlightInto(layer, layerText(src), { format: options.format ?? detectFormat(src) });
		syncScroll();
	};

	const resize = new view.ResizeObserver(syncBox);
	resize.observe(textarea);
	textarea.addEventListener("input", refresh);
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
			textarea.removeEventListener("input", refresh);
			textarea.removeEventListener("scroll", syncScroll);
			if (addedInputClass) textarea.classList.remove("bh-input");
			wrap.before(textarea);
			wrap.remove();
		},
	};
	attached.set(textarea, handle);
	return handle;
}

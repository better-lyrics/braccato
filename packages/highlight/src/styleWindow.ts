import type { Token } from "./types.js";

/** Source offsets [from, to) whose tokens render styled; everything else renders as plain text. */
export interface StyleWindow {
	from: number;
	to: number;
}

export const EVERYTHING: StyleWindow = { from: 0, to: Number.POSITIVE_INFINITY };
export const NOTHING: StyleWindow = { from: 0, to: 0 };

export function projectLine(tokens: readonly Token[], lineStart: number, window: StyleWindow): readonly Token[] {
	let length = 0;
	for (const token of tokens) length += token.text.length;
	if (window.from <= lineStart && window.to >= lineStart + length) return tokens;
	const out: Token[] = [];
	let at = lineStart;
	for (const token of tokens) {
		const end = at + token.text.length;
		const type = end > window.from && at < window.to ? token.type : "text";
		const last = out[out.length - 1];
		if (last && last.type === type) last.text += token.text;
		else out.push({ type, text: token.text });
		at = end;
	}
	return out;
}

const PREFIX_BLOCK = 1024;

export function shiftWindow(window: StyleWindow, prev: string, next: string): StyleWindow {
	const shorter = Math.min(prev.length, next.length);
	let edit = 0;
	while (
		edit + PREFIX_BLOCK <= shorter &&
		prev.slice(edit, edit + PREFIX_BLOCK) === next.slice(edit, edit + PREFIX_BLOCK)
	)
		edit += PREFIX_BLOCK;
	while (edit < shorter && prev.charCodeAt(edit) === next.charCodeAt(edit)) edit++;
	const delta = next.length - prev.length;
	const shift = (bound: number) => (bound > edit ? Math.max(edit, bound + delta) : bound);
	return { from: shift(window.from), to: shift(window.to) };
}

// -- Measuring --------------------------

export interface RenderedLines {
	layer: HTMLElement;
	lineEls: readonly HTMLElement[];
	lineNodes: readonly (readonly ChildNode[])[];
	shown: readonly (readonly Token[])[];
	starts: readonly number[];
	length: number;
}

export function firstIndex(count: number, passes: (index: number) => boolean): number {
	let lo = 0;
	let hi = count;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (passes(mid)) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

/** The first source offset, within the node laid out across y, whose box reaches below y ("bottom") or starts at or below it ("top"). */
function offsetAtY(rendered: RenderedLines, range: Range, y: number, edge: "bottom" | "top"): number {
	const { lineEls, lineNodes, shown, starts, length } = rendered;
	const passes = (box: DOMRect) => (edge === "bottom" ? box.bottom > y : box.top >= y);
	const line = firstIndex(lineEls.length, (k) => lineEls[k].getBoundingClientRect().bottom > y);
	if (line === lineEls.length) return length;
	const nodes = lineNodes[line];
	const node = firstIndex(nodes.length, (k) => {
		range.selectNode(nodes[k]);
		return range.getBoundingClientRect().bottom > y;
	});
	let offset = starts[line];
	for (let k = 0; k < node; k++) offset += shown[line][k].text.length;
	if (node === nodes.length) return offset;
	const text = (shown[line][node].type === "text" ? nodes[node] : nodes[node].firstChild) as Text;
	const chars = text.data.endsWith("\n") ? text.data.length - 1 : text.data.length;
	return (
		offset +
		firstIndex(chars, (k) => {
			const low = text.data.charCodeAt(k) >= 0xdc00 && text.data.charCodeAt(k) <= 0xdfff;
			range.setStart(text, low ? k - 1 : k);
			range.setEnd(text, k + 1);
			return passes(range.getBoundingClientRect());
		})
	);
}

/** The source offsets laid out within `margin` layer heights above and below the layer's visible box. */
export function visibleWindow(rendered: RenderedLines, margin: number): StyleWindow {
	const { layer } = rendered;
	const height = layer.clientHeight;
	if (!height || rendered.lineEls.length === 0) return EVERYTHING;
	const top = layer.getBoundingClientRect().top + layer.clientTop;
	const range = layer.ownerDocument.createRange();
	return {
		from: offsetAtY(rendered, range, top - height * margin, "bottom"),
		to: offsetAtY(rendered, range, top + height * (1 + margin), "top"),
	};
}

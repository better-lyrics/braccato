import type { Token, TokenType } from "./types.js";

const highlightName = (type: TokenType): string => `bh-${type}`;

export interface PaintedToken {
	type: TokenType;
	range: StaticRange;
}

export interface TokenPainter {
	paint(text: Text, tokens: readonly Token[]): PaintedToken[];
	clear(painted: readonly PaintedToken[]): void;
}

type HighlightWindow = Window & {
	Highlight?: typeof Highlight;
	StaticRange?: typeof StaticRange;
	CSS?: { highlights?: HighlightRegistry };
};

/** Null without the CSS Custom Highlight API; the layer then shows plain text, still aligned with the textarea. */
export function tokenPainter(view: Window): TokenPainter | null {
	const { Highlight, StaticRange, CSS } = view as HighlightWindow;
	const registry = CSS?.highlights;
	if (!Highlight || !StaticRange || !registry) return null;
	const highlightOf = (type: TokenType) => {
		const name = highlightName(type);
		const existing = registry.get(name);
		if (existing) return existing;
		const created = new Highlight();
		registry.set(name, created);
		return created;
	};
	return {
		paint(text, tokens) {
			const painted: PaintedToken[] = [];
			let at = 0;
			for (const { type, text: chunk } of tokens) {
				const end = at + chunk.length;
				if (type !== "text") {
					const range = new StaticRange({ startContainer: text, startOffset: at, endContainer: text, endOffset: end });
					highlightOf(type).add(range);
					painted.push({ type, range });
				}
				at = end;
			}
			return painted;
		},
		clear(painted) {
			for (const { type, range } of painted) {
				const name = highlightName(type);
				const highlight = registry.get(name);
				if (!highlight) continue;
				highlight.delete(range);
				if (highlight.size === 0) registry.delete(name);
			}
		},
	};
}

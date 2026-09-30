import { detectFormat } from "@braccato/parsers/format";
import { prettyTtml } from "./pretty.js";
import { tokenize } from "./tokenize.js";
import type { LyricFormat } from "./types.js";

export interface HighlightOptions {
	format?: LyricFormat;
	/** Break minified TTML into lines. Display only: the text no longer matches the source. */
	pretty?: boolean;
}

export function highlightInto(el: HTMLElement, src: string, options: HighlightOptions = {}): LyricFormat {
	const format = options.format ?? detectFormat(src);
	const text = options.pretty && format === "ttml" ? prettyTtml(src) : src;
	const doc = el.ownerDocument;
	el.replaceChildren(
		...tokenize(text, format).map(({ type, text: part }) => {
			if (type === "text") return doc.createTextNode(part);
			const span = doc.createElement("span");
			span.className = `bh-${type}`;
			span.textContent = part;
			return span;
		}),
	);
	return format;
}

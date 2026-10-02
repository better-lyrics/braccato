import { detectFormat } from "@braccato/parsers/format";
import { prettyTtml } from "./pretty.js";
import { tokenize } from "./tokenize.js";
import type { LyricFormat, Token } from "./types.js";

export interface HighlightOptions {
	format?: LyricFormat;
	/** Break minified TTML into lines. Display only: the text no longer matches the source. */
	pretty?: boolean;
}

function tokenNode(doc: Document, { type, text }: Token): ChildNode {
	if (type === "text") return doc.createTextNode(text);
	const span = doc.createElement("span");
	span.className = `bh-${type}`;
	span.textContent = text;
	return span;
}

export function appendTokens(parent: DocumentFragment | HTMLElement, tokens: readonly Token[]): void {
	const doc = parent.ownerDocument as Document;
	for (const token of tokens) parent.append(tokenNode(doc, token));
}

export function highlightInto(el: HTMLElement, src: string, options: HighlightOptions = {}): LyricFormat {
	const format = options.format ?? detectFormat(src);
	const text = options.pretty && format === "ttml" ? prettyTtml(src) : src;
	el.classList.add("bh");
	const fragment = el.ownerDocument.createDocumentFragment();
	appendTokens(fragment, tokenize(text, format));
	el.replaceChildren(fragment);
	return format;
}

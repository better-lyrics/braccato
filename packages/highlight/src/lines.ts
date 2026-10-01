import type { Token } from "./types.js";

export function splitLines(tokens: readonly Token[]): Token[][] {
	const lines: Token[][] = [];
	let line: Token[] = [];
	for (const { type, text } of tokens) {
		let from = 0;
		for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", from)) {
			line.push({ type, text: text.slice(from, at + 1) });
			lines.push(line);
			line = [];
			from = at + 1;
		}
		if (from < text.length) line.push({ type, text: from === 0 ? text : text.slice(from) });
	}
	if (line.length > 0) lines.push(line);
	return lines;
}

function sameToken(a: Token, b: Token): boolean {
	return a.type === b.type && a.text === b.text;
}

function sameLine(a: readonly Token[], b: readonly Token[]): boolean {
	if (a.length !== b.length) return false;
	for (let k = 0; k < a.length; k++) if (!sameToken(a[k], b[k])) return false;
	return true;
}

export interface LineRange {
	start: number;
	prevEnd: number;
	nextEnd: number;
}

/** Items [start, prevEnd) of prev became items [start, nextEnd) of next; everything around them is unchanged. */
function changedItems<T>(prev: readonly T[], next: readonly T[], same: (a: T, b: T) => boolean): LineRange {
	const shorter = Math.min(prev.length, next.length);
	let start = 0;
	while (start < shorter && same(prev[start], next[start])) start++;
	let tail = 0;
	while (tail < shorter - start && same(prev[prev.length - 1 - tail], next[next.length - 1 - tail])) tail++;
	return { start, prevEnd: prev.length - tail, nextEnd: next.length - tail };
}

export function changedRange(prev: readonly Token[][], next: readonly Token[][]): LineRange {
	return changedItems(prev, next, sameLine);
}

export function changedTokens(prev: readonly Token[], next: readonly Token[]): LineRange {
	return changedItems(prev, next, sameToken);
}

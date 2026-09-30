import { detectFormat } from "@braccato/parsers/format";
import type { LyricFormat, Token, TokenType } from "./types.js";

type LineTokenizer = (line: string, out: Token[]) => void;

function push(out: Token[], type: TokenType, text: string): void {
	if (text) out.push({ type, text });
}

// -- Line formats --------------------------

const LINE_BREAK = /(\r\n|\n|\r)/;

function tokenizeLines(src: string, line: LineTokenizer): Token[] {
	const out: Token[] = [];
	src.split(LINE_BREAK).forEach((part, index) => {
		if (index % 2 === 1) push(out, "text", part);
		else line(part, out);
	});
	return out;
}

const META_LINE = /^(\s*)\[([a-zA-Z#]+)(:)(.*)(\])(\s*)$/;

function metaLine(line: string, out: Token[]): boolean {
	const m = META_LINE.exec(line);
	if (!m) return false;
	push(out, "text", m[1]);
	push(out, "punct", "[");
	push(out, "meta", m[2]);
	push(out, "punct", ":");
	push(out, "value", m[4]);
	push(out, "punct", "]");
	push(out, "text", m[6]);
	return true;
}

// A single capture group puts every stamp at an odd index of split(), whatever the text around it looks like.
function wordStamps(rest: string, stamp: RegExp, open: string, close: string, out: Token[]): void {
	rest.split(stamp).forEach((piece, index) => {
		if (index % 2 === 0) {
			push(out, "text", piece);
			return;
		}
		push(out, "punct", open);
		push(out, "wordTime", piece.slice(open.length, -close.length));
		push(out, "punct", close);
	});
}

const LRC_LINE_STAMP = /^\[(\d+:\d+(?:[.:]\d+)?)\]/;
const LRC_WORD_STAMP = /(<\d+:\d+(?:[.:]\d+)?>)/;
const VOICE = /^(\s*)(v\d+|bg)(:)/;

function lrcLine(line: string, out: Token[]): void {
	if (metaLine(line, out)) return;
	let rest = line;
	for (let m = LRC_LINE_STAMP.exec(rest); m; m = LRC_LINE_STAMP.exec(rest)) {
		push(out, "punct", "[");
		push(out, "timestamp", m[1]);
		push(out, "punct", "]");
		rest = rest.slice(m[0].length);
	}
	const voice = VOICE.exec(rest);
	if (voice) {
		push(out, "text", voice[1]);
		push(out, "agent", voice[2]);
		push(out, "punct", ":");
		rest = rest.slice(voice[0].length);
	}
	wordStamps(rest, LRC_WORD_STAMP, "<", ">", out);
}

const QRC_LINE_STAMP = /^\[(\d+,\d+)\]/;
const QRC_WORD_STAMP = /(\(\d+,\d+\))/;

function qrcLine(line: string, out: Token[]): void {
	if (metaLine(line, out)) return;
	let rest = line;
	const lead = QRC_LINE_STAMP.exec(rest);
	if (lead) {
		push(out, "punct", "[");
		push(out, "timestamp", lead[1]);
		push(out, "punct", "]");
		rest = rest.slice(lead[0].length);
	}
	wordStamps(rest, QRC_WORD_STAMP, "(", ")", out);
}

const SRT_CUE = /^(\s*)(\d{2}:\d{2}:\d{2}[,.]\d{3})(\s*-->\s*)(\d{2}:\d{2}:\d{2}[,.]\d{3})(.*)$/;

function srtLine(line: string, out: Token[]): void {
	const cue = SRT_CUE.exec(line);
	if (cue) {
		push(out, "text", cue[1]);
		push(out, "timestamp", cue[2]);
		push(out, "punct", cue[3]);
		push(out, "timestamp", cue[4]);
		push(out, "text", cue[5]);
	} else if (/^\s*\d+\s*$/.test(line)) push(out, "meta", line);
	else push(out, "text", line);
}

// -- TTML --------------------------

const TIME_ATTRS = new Set(["begin", "end", "dur"]);
const AGENT_ATTRS = new Set(["ttm:agent", "ttm:role", "xml:id"]);
const TAG_HEAD = /^<(\/?)([\w:.-]*)/;
const HEAD_TAGS = new Set(["head", "tt:head"]);

function tokenizeXml(src: string): Token[] {
	const out: Token[] = [];
	const bgStack: boolean[] = [];
	let bgDepth = 0;
	let headDepth = 0;
	let i = 0;
	while (i < src.length) {
		if (src.startsWith("<!--", i) || src.startsWith("<?", i)) {
			const close = src.startsWith("<!--", i) ? "-->" : "?>";
			const end = src.indexOf(close, i);
			const j = end < 0 ? src.length : end + close.length;
			push(out, "comment", src.slice(i, j));
			i = j;
			continue;
		}
		if (src[i] === "<") {
			const end = src.indexOf(">", i);
			const j = end < 0 ? src.length : end + 1;
			const tag = src.slice(i, j);
			const head = TAG_HEAD.exec(tag) as RegExpExecArray;
			const closing = head[1] === "/";
			const name = head[2];
			push(out, "punct", `<${head[1]}`);
			push(out, "tag", name);
			// A sticky regex resets lastIndex to 0 when exec fails, so track the position separately:
			// reading lastIndex after the loop re-emitted every attribute as punctuation.
			const attr = /(\s+)([\w:.-]+)(\s*=\s*)?("[^"]*"|'[^']*')?/y;
			let pos = head[0].length;
			attr.lastIndex = pos;
			let isBg = false;
			for (let m = attr.exec(tag); m; m = attr.exec(tag)) {
				pos = attr.lastIndex;
				push(out, "text", m[1]);
				push(out, "attr", m[2]);
				if (m[3]) push(out, "punct", m[3]);
				if (m[4]) {
					const inner = m[4].slice(1, -1);
					const type: TokenType = TIME_ATTRS.has(m[2]) ? "timestamp" : AGENT_ATTRS.has(m[2]) ? "agent" : "value";
					push(out, "punct", m[4][0]);
					push(out, type, inner);
					push(out, "punct", m[4][0]);
					if (m[2] === "ttm:role" && inner === "x-bg") isBg = true;
				}
			}
			push(out, "punct", tag.slice(pos));
			if (!closing && !tag.endsWith("/>")) {
				bgStack.push(isBg);
				if (isBg) bgDepth++;
				if (HEAD_TAGS.has(name)) headDepth++;
			} else if (closing) {
				if (bgStack.pop()) bgDepth--;
				if (HEAD_TAGS.has(name)) headDepth--;
			}
			i = j;
			continue;
		}
		const next = src.indexOf("<", i);
		const j = next < 0 ? src.length : next;
		push(out, headDepth > 0 ? "meta" : bgDepth > 0 ? "bgText" : "text", src.slice(i, j));
		i = j;
	}
	return out;
}

// -- Entry --------------------------

export function tokenize(src: string, format: LyricFormat = detectFormat(src)): Token[] {
	switch (format) {
		case "ttml":
			return tokenizeXml(src);
		case "lrc":
			return tokenizeLines(src, lrcLine);
		case "qrc":
			return tokenizeLines(src, qrcLine);
		case "srt":
			return tokenizeLines(src, srtLine);
		default:
			return src ? [{ type: "text", text: src }] : [];
	}
}

import { detectFormat } from "@braccato/parsers/format";
import type { LyricFormat, Token, TokenType } from "./types.js";

type LineTokenizer = (line: string, out: Token[]) => void;

function push(out: Token[], type: TokenType, text: string): void {
	if (text) out.push({ type, text });
}

// -- Line formats --------------------------

function tokenizeLines(src: string, line: LineTokenizer): Token[] {
	const out: Token[] = [];
	for (const part of src.split(/(\r?\n)/)) {
		if (part === "\n" || part === "\r\n") push(out, "text", part);
		else line(part, out);
	}
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
	for (const piece of rest.split(LRC_WORD_STAMP)) {
		if (/^<\d/.test(piece)) {
			push(out, "punct", "<");
			push(out, "wordTime", piece.slice(1, -1));
			push(out, "punct", ">");
		} else push(out, "text", piece);
	}
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
	for (const piece of rest.split(QRC_WORD_STAMP)) {
		if (/^\(\d/.test(piece)) {
			push(out, "punct", "(");
			push(out, "wordTime", piece.slice(1, -1));
			push(out, "punct", ")");
		} else push(out, "text", piece);
	}
}

// -- Entry --------------------------

export function tokenize(src: string, format: LyricFormat = detectFormat(src)): Token[] {
	switch (format) {
		case "lrc":
			return tokenizeLines(src, lrcLine);
		case "qrc":
			return tokenizeLines(src, qrcLine);
		default:
			return src ? [{ type: "text", text: src }] : [];
	}
}

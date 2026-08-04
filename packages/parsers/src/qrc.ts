import { insertInstrumentalBreaks } from "./instrumentalBreaks.js";
import { stringSimilarity } from "./stringSimilarity.js";
import type { Lyric, LyricParser, LyricPart } from "./types.js";

/** Song metadata, used to drop opening lines that only echo the title or the artist. */
export interface QrcMetadata {
	title?: string;
	artist?: string;
}

// -- Line/Word Time Parsing --------------------------

function parseLineTime(src: string): { startTime: number; duration: number; rest: string } | null {
	if (src[0] !== "[") return null;
	const close = src.indexOf("]");
	if (close === -1) return null;
	const comma = src.indexOf(",", 1);
	if (comma === -1 || comma > close) return null;
	const startTime = Number.parseInt(src.slice(1, comma), 10);
	const duration = Number.parseInt(src.slice(comma + 1, close), 10);
	if (Number.isNaN(startTime) || Number.isNaN(duration)) return null;
	return { startTime, duration, rest: src.slice(close + 1) };
}

interface ParsedWord {
	text: string;
	time: number;
	duration: number;
}

const TIMING_TOKEN_REGEX = /\((\d+),(\d+)\)/g;

/**
 * Only the timing tokens are matched; each syllable is the span of text between the end of the
 * previous token and the start of this one. Capturing that text in the pattern instead costs either
 * correctness or time: a lazy `.*?` backtracks over the whole line from every start position when a
 * line holds unmatched brackets, and a `[^(]*` that avoids the backtracking cannot read a syllable
 * with a bracket in it. Reading the span keeps both.
 */
function parseWords(src: string): ParsedWord[] {
	const words: ParsedWord[] = [];
	let textStart = 0;

	for (const match of src.matchAll(TIMING_TOKEN_REGEX)) {
		words.push({
			text: src.slice(textStart, match.index),
			time: Number.parseInt(match[1], 10),
			duration: Number.parseInt(match[2], 10),
		});
		textStart = match.index + match[0].length;
	}

	return words;
}

// -- Metadata/Credit Detection --------------------------

const CREDIT_PREFIXES = [
	"词",
	"作词",
	"曲",
	"作曲",
	"编曲",
	"和声",
	"混音",
	"吉他",
	"制作人",
	"演唱",
	"原唱",
	"翻唱",
	"后期",
	"和音",
	"录音",
	"策划",
	"伴奏",
	"美工",
	"海报",
	"旁白",
	"writtenby",
	"producedby",
	"composedby",
	"arrangedby",
	"mixing",
	"mastering",
	"vocal",
	"vocals",
	"guitar",
	"bass",
	"drums",
	"producer",
	"lyricist",
	"composer",
	"arranger",
	"lyricsby",
];

function isMetadataPrefix(name: string): boolean {
	const n = name.toLowerCase().replace(/\s+/g, "");
	return CREDIT_PREFIXES.includes(n) || n.endsWith("词") || n.endsWith("曲") || n.endsWith("声") || n.endsWith("音");
}

// -- Singer/Agent Detection --------------------------

interface AgentsCtx {
	aliases: Record<string, string>;
	nextVoiceId: number;
	currentSinger: string | null;
}

interface ParsedLine {
	time: number;
	duration: number;
	text: string;
	syllables: ParsedWord[];
	agent: string | null;
}

function assignAgent(singerName: string, parsedLine: ParsedLine, ctx: AgentsCtx): void {
	if (!ctx.aliases[singerName]) {
		const upper = singerName.toUpperCase();
		const type = upper === "合" || upper === "ALL" || upper === "合唱" ? "group" : "person";
		ctx.aliases[singerName] = type === "group" ? "v1000" : `v${ctx.nextVoiceId++}`;
	}
	parsedLine.agent = ctx.aliases[singerName];
}

function updateLineTiming(parsedLine: ParsedLine): void {
	if (parsedLine.syllables.length > 0) {
		const first = parsedLine.syllables[0];
		const last = parsedLine.syllables[parsedLine.syllables.length - 1];
		parsedLine.time = first.time;
		parsedLine.duration = last.time + last.duration - first.time;
	}
}

const NON_WORD_REGEX = /[^a-z0-9　-鿿가-힯]/g;

function extractSinger(
	parsedLine: ParsedLine,
	ctx: AgentsCtx,
	isFirstFewLines: boolean,
	metadata?: QrcMetadata,
): boolean {
	if (!parsedLine.syllables.length) {
		if (ctx.currentSinger) parsedLine.agent = ctx.currentSinger;
		return true;
	}

	// Drop lines near the start that echo title/artist
	if (isFirstFewLines) {
		if (metadata && (metadata.title || metadata.artist)) {
			const norm = (s: string) => s.toLowerCase().replace(NON_WORD_REGEX, "");
			const text = norm(parsedLine.text);
			const title = norm(metadata.title ?? "");
			const artist = norm(metadata.artist ?? "");

			if (title && text.includes(title) && artist && text.includes(artist)) return false;
			if (title && text.includes(title) && !artist && text.length < title.length + 15) return false;
			if (artist && text === artist) return false;

			const ref = `${metadata.title ?? ""} ${metadata.artist ?? ""}`;
			if (stringSimilarity(parsedLine.text, ref) > 0.5) return false;
		}

		const allSameDuration =
			parsedLine.syllables.length > 2 &&
			parsedLine.syllables.every((w, _, arr) => {
				return Math.abs(w.duration - arr[0].duration) < 10;
			});
		if (allSameDuration) return false;
	}

	if (ctx.currentSinger) parsedLine.agent = ctx.currentSinger;

	let accText = "";
	let syllablesToRemove = 0;
	for (const syl of parsedLine.syllables) {
		accText += syl.text;
		syllablesToRemove++;
		if (accText.includes(":") || accText.includes("：")) break;
		if (accText.length > 40) return true;
	}

	// Case A: the whole accumulated text is "Name:" with nothing after the colon
	const fullMatch = accText.match(/^([^:：]+)\s*[:：]\s*$/);
	if (fullMatch) {
		const singerName = fullMatch[1].trim();
		if (isMetadataPrefix(singerName)) return false;
		if (singerName.length > 30) return true;

		parsedLine.syllables = parsedLine.syllables.slice(syllablesToRemove);
		parsedLine.text = parsedLine.text.substring(accText.length);
		assignAgent(singerName, parsedLine, ctx);
		ctx.currentSinger = ctx.aliases[singerName];
		updateLineTiming(parsedLine);
		return true;
	}

	// Case B: "Name: lyrics..." where the colon lands mid-syllable with content after it
	const prefixBeforeColon = accText.match(/^([^:：]+)\s*[:：]\s*([\s\S]*)$/);
	if (!prefixBeforeColon) return true;

	const singerName = prefixBeforeColon[1].trim();
	if (isMetadataPrefix(singerName)) return false;
	if (singerName.length > 20) return true;

	const afterColon = prefixBeforeColon[2] || "";
	const colonSylIdx = syllablesToRemove - 1;
	const colonSyl = parsedLine.syllables[colonSylIdx];
	const colonMatch = colonSyl.text.match(/[:：]\s*([\s\S]*)$/);
	const remainderInColonSyl = colonMatch ? colonMatch[1] : "";

	if (remainderInColonSyl.length > 0) {
		colonSyl.text = remainderInColonSyl;
		parsedLine.syllables = parsedLine.syllables.slice(colonSylIdx);
	} else {
		parsedLine.syllables = parsedLine.syllables.slice(syllablesToRemove);
	}

	assignAgent(singerName, parsedLine, ctx);
	ctx.currentSinger = ctx.aliases[singerName];
	parsedLine.text = afterColon;
	updateLineTiming(parsedLine);

	return true;
}

// -- Envelope --------------------------

const LYRIC_CONTENT_REGEX = /LyricContent="([\s\S]*?)"\s*(?:\/?>|[a-zA-Z]+=)/;

/**
 * QQ Music serves QRC inside an XML envelope with the body hidden in a `LyricContent` attribute.
 * A bare body is passed through untouched, since that is what a caller holding an already unwrapped
 * document has.
 */
function unwrapEnvelope(qrcXml: string): string {
	const attrMatch = qrcXml.match(LYRIC_CONTENT_REGEX);
	if (!attrMatch) return qrcXml;
	return attrMatch[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

// -- Main Parser --------------------------

/**
 * Parse a QRC document, either the `<QrcInfos>` envelope QQ Music returns or a bare QRC body.
 *
 * `metadata` is optional and only used to drop opening lines that echo the song title or artist,
 * which QQ Music routinely prepends to a lyric body.
 */
export function parseQRC(qrcXml: string, songDurationMs: number, metadata?: QrcMetadata): Lyric[] {
	if (!qrcXml) return [];

	const lyricContent = unwrapEnvelope(qrcXml);

	const parsedLines: ParsedLine[] = [];
	const agentsCtx: AgentsCtx = { aliases: {}, nextVoiceId: 1, currentSinger: null };

	for (const raw of lyricContent.split("\n")) {
		const trimmed = raw.trim();
		if (!trimmed) continue;

		// Skip the bracketed metadata tags a QQ Music body carries
		if (/^\[[a-zA-Z]+:/.test(trimmed)) continue;

		const lineTime = parseLineTime(trimmed);
		if (!lineTime) continue;

		const syllables = parseWords(lineTime.rest);
		const text = syllables.map((w) => w.text).join("");

		const parsed: ParsedLine = {
			time: lineTime.startTime,
			duration: lineTime.duration,
			text,
			syllables,
			agent: null,
		};

		if (extractSinger(parsed, agentsCtx, parsedLines.length < 5, metadata)) {
			parsedLines.push(parsed);
		}
	}

	if (parsedLines.length === 0) return [];

	const lyrics: Lyric[] = parsedLines.map((line, index) => {
		const parts: LyricPart[] = line.syllables.map((syl) => ({
			startTimeMs: syl.time,
			words: syl.text,
			durationMs: syl.duration,
		}));

		// Take the duration from the next line when the line carries none
		let duration = line.duration;
		if (duration === 0 && index + 1 < parsedLines.length) {
			duration = Math.max(parsedLines[index + 1].time - line.time, 0);
		} else if (duration === 0) {
			duration = songDurationMs - line.time;
		}

		if (parts.length > 0) {
			const lastPart = parts[parts.length - 1];
			if (lastPart.durationMs === 0) {
				if (index + 1 < parsedLines.length) {
					lastPart.durationMs = Math.max(parsedLines[index + 1].time - lastPart.startTimeMs, 0);
				} else {
					lastPart.durationMs = songDurationMs - lastPart.startTimeMs;
				}
			}
		}

		return {
			startTimeMs: line.time,
			words: line.text,
			durationMs: duration,
			parts: parts.length > 0 ? parts : undefined,
			agent: line.agent ?? undefined,
		};
	});

	return insertInstrumentalBreaks(lyrics, songDurationMs);
}

export const QRCParser: LyricParser = {
	detect(input: string): boolean {
		if (input.includes("<QrcInfos>") || input.includes("LyricContent=")) return true;
		return /\[\d+,\d+\]/.test(input) && /\(\d+,\d+\)/.test(input);
	},
	parse(input: string, duration = 0): Lyric[] {
		return parseQRC(input, duration);
	},
};

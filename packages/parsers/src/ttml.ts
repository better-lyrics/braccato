import type { Lyric, LyricParser, LyricPart } from "./types.js";

const DEFAULT_INSTRUMENTAL_GAP_MS = 5000;

function parseTime(timeStr: string | number | undefined): number {
	if (!timeStr) return 0;
	if (typeof timeStr === "number") return timeStr;

	const offsetTimeMatch = timeStr.match(/^([\d.]+)(h|m|s|ms)$/);
	if (offsetTimeMatch) {
		const value = Number.parseFloat(offsetTimeMatch[1]);
		const unit = offsetTimeMatch[2];
		if (unit === "h") return Math.round(value * 3600000);
		if (unit === "m") return Math.round(value * 60000);
		if (unit === "s") return Math.round(value * 1000);
		if (unit === "ms") return Math.round(value);
	}

	const parts = timeStr.split(":").map((val) => val.replace(/[^0-9.]/g, ""));
	let totalMs = 0;

	try {
		if (parts.length === 1) {
			totalMs = Number.parseFloat(parts[0]) * 1000;
		} else if (parts.length === 2) {
			totalMs = Number.parseInt(parts[0], 10) * 60000 + Number.parseFloat(parts[1]) * 1000;
		} else if (parts.length === 3) {
			totalMs =
				Number.parseInt(parts[0], 10) * 3600000 +
				Number.parseInt(parts[1], 10) * 60000 +
				Number.parseFloat(parts[2]) * 1000;
		}
		return Math.round(totalMs);
	} catch {
		return 0;
	}
}

export { parseTime as parseTTMLTime };

// Namespace-agnostic attribute lookup — matches by localName regardless of
// prefix (ttm:agent → "agent", itunes:key → "key", xml:id → "id")
function getAttr(el: Element, localName: string): string | null {
	const val = el.getAttribute(localName);
	if (val !== null) return val;
	for (const attr of el.attributes) {
		if (attr.localName === localName) return attr.value;
	}
	return null;
}

interface ParsedSpan {
	text: string;
	begin?: number;
	end?: number;
	role?: string;
	children: ParsedSpan[];
}

function domToSpan(el: Element): ParsedSpan {
	const span: ParsedSpan = {
		text: "",
		begin: getAttr(el, "begin") ? parseTime(getAttr(el, "begin")!) : undefined,
		end: getAttr(el, "end") ? parseTime(getAttr(el, "end")!) : undefined,
		role: getAttr(el, "role") ?? undefined,
		children: [],
	};

	for (const node of el.childNodes) {
		if (node.nodeType === 3) {
			const text = node.textContent ?? "";
			span.text += text;
			// Interleave text nodes as children to preserve spaces between
			// element nodes (critical for spaces between background vocal words)
			span.children.push({ text, children: [] });
		} else if (node.nodeType === 1) {
			span.children.push(domToSpan(node as Element));
		}
	}

	return span;
}

function extractParts(
	spans: ParsedSpan[],
	beginTime: number,
	parentIsBackground = false,
): { parts: LyricPart[]; text: string; isWordSynced: boolean } {
	let text = "";
	const parts: LyricPart[] = [];
	let isWordSynced = false;

	for (const span of spans) {
		const isBackground = parentIsBackground || span.role === "x-bg";

		if (span.children.length > 0) {
			if (isBackground && !parentIsBackground) {
				const sub = extractParts(span.children, beginTime, true);
				text += sub.text;
				parts.push(...sub.parts);
				if (sub.isWordSynced) isWordSynced = true;
			} else if (span.begin !== undefined && span.end !== undefined) {
				const innerText = span.children.map((c) => c.text).join("") || span.text;
				parts.push({
					startTimeMs: span.begin,
					durationMs: span.end - span.begin,
					words: innerText,
					isBackground: isBackground || undefined,
				});
				text += innerText;
				isWordSynced = true;
			} else {
				const sub = extractParts(span.children, beginTime, isBackground);
				text += sub.text;
				parts.push(...sub.parts);
				if (sub.isWordSynced) isWordSynced = true;
			}
		} else if (span.text) {
			text += span.text;
			if (span.begin !== undefined && span.end !== undefined) {
				parts.push({
					startTimeMs: span.begin,
					durationMs: span.end - span.begin,
					words: span.text,
					isBackground: isBackground || undefined,
				});
				isWordSynced = true;
			} else {
				const lastPart = parts[parts.length - 1];
				parts.push({
					startTimeMs: lastPart ? lastPart.startTimeMs + lastPart.durationMs : beginTime,
					durationMs: 0,
					words: span.text,
					isBackground: isBackground || undefined,
				});
			}
		}
	}

	if (!isWordSynced) {
		return { parts: [], text, isWordSynced: false };
	}

	return { parts, text, isWordSynced };
}

function insertInstrumentalBreaks(lyrics: Lyric[], songDurationMs: number, gapThreshold: number): Lyric[] {
	if (lyrics.length === 0) return lyrics;

	const result: Lyric[] = [];
	const mkInstrumental = (startTimeMs: number, durationMs: number): Lyric => ({
		startTimeMs,
		durationMs,
		words: "",
		parts: [],
		isInstrumental: true,
	});

	if (lyrics[0].startTimeMs > gapThreshold) {
		result.push(mkInstrumental(0, lyrics[0].startTimeMs));
	}

	for (let i = 0; i < lyrics.length; i++) {
		result.push(lyrics[i]);
		if (i < lyrics.length - 1) {
			const currentEnd = lyrics[i].startTimeMs + lyrics[i].durationMs;
			const nextStart = lyrics[i + 1].startTimeMs;
			const gap = nextStart - currentEnd;
			if (gap > gapThreshold) {
				result.push(mkInstrumental(currentEnd, gap));
			}
		}
	}

	const last = lyrics[lyrics.length - 1];
	const lastEnd = last.startTimeMs + last.durationMs;
	if (songDurationMs - lastEnd > gapThreshold) {
		result.push(mkInstrumental(lastEnd, songDurationMs - lastEnd));
	}

	return result;
}

function parseTTMLContent(
	xml: string,
	options: { instrumentalGapMs?: number } = {},
): { lyrics: Lyric[]; isWordSynced: boolean; language?: string } {
	const cleanedXml = xml.replace(/\\"/g, '"');
	const parser = new DOMParser();
	const doc = parser.parseFromString(cleanedXml, "text/xml");

	const ttEl = doc.querySelector("tt");
	const lang = (ttEl ? getAttr(ttEl, "lang") : null) ?? undefined;

	const body = doc.querySelector("body");
	if (!body) return { lyrics: [], isWordSynced: false, language: lang };

	const bodyDurAttr = body.getAttribute("dur");
	const songDurationMs = bodyDurAttr ? parseTime(bodyDurAttr) : 0;

	const pElements = body.querySelectorAll("p");
	const lyrics = new Map<string, Lyric>();
	let isWordSynced = false;

	// -- Agent mapping --
	const agentMapping = new Map<string, string>();
	const agentEls = [
		...doc.querySelectorAll("agent"),
		...doc.getElementsByTagNameNS("http://www.w3.org/ns/ttml#metadata", "agent"),
	];
	let voiceIndex = 0;
	for (const agentEl of agentEls) {
		const id = getAttr(agentEl, "id");
		const type = getAttr(agentEl, "type");
		if (!id) continue;
		if (agentMapping.has(id)) continue;
		if (type === "person" || type === "character") {
			voiceIndex++;
			agentMapping.set(id, `v${voiceIndex}`);
		} else {
			agentMapping.set(id, "v1000");
		}
	}

	for (const p of pElements) {
		const beginTimeMs = parseTime(getAttr(p, "begin") ?? undefined);
		const endTimeMs = parseTime(getAttr(p, "end") ?? undefined);
		const key = getAttr(p, "key") ?? String(lyrics.size);
		const rawAgent = getAttr(p, "agent") ?? undefined;
		const normalizedAgent = rawAgent ? (agentMapping.get(rawAgent) ?? rawAgent) : undefined;

		const spans = Array.from(p.childNodes)
			.filter((n) => n.nodeType === 1 || n.nodeType === 3)
			.map((n) =>
				n.nodeType === 1 ? domToSpan(n as Element) : { text: n.textContent ?? "", children: [] as ParsedSpan[] },
			) as ParsedSpan[];

		const parsed = extractParts(spans, beginTimeMs);
		if (parsed.isWordSynced) isWordSynced = true;

		lyrics.set(key, {
			agent: normalizedAgent,
			durationMs: endTimeMs - beginTimeMs,
			parts: parsed.parts,
			startTimeMs: beginTimeMs,
			words: parsed.text,
			key,
		});
	}

	// -- Translations --
	const translationContainers = doc.querySelectorAll("translations");
	for (const tc of translationContainers) {
		const lang = tc.getAttribute("lang");
		if (!lang) continue;
		const translations = tc.querySelectorAll("translation");
		for (const t of translations) {
			const forKey = t.getAttribute("for");
			const textEl = t.querySelector("text");
			const text = textEl?.textContent;
			if (forKey && text) {
				const line = lyrics.get(forKey);
				if (line) line.translation = { text, lang };
			}
		}
	}

	// -- Transliterations --
	const translitContainers = doc.querySelectorAll("transliterations");
	for (const tc of translitContainers) {
		const translits = tc.querySelectorAll("transliteration");
		for (const t of translits) {
			const forKey = t.getAttribute("for");
			if (!forKey) continue;
			const line = lyrics.get(forKey);
			if (!line) continue;

			const textEls = t.querySelectorAll("text");
			let romanText = "";
			const romanParts: LyricPart[] = [];

			for (const textEl of textEls) {
				const spans = Array.from(textEl.childNodes)
					.filter((n) => n.nodeType === 1 || n.nodeType === 3)
					.map((n) =>
						n.nodeType === 1 ? domToSpan(n as Element) : { text: n.textContent ?? "", children: [] as ParsedSpan[] },
					) as ParsedSpan[];

				const parsed = extractParts(spans, line.startTimeMs);
				romanText += parsed.text;
				romanParts.push(...parsed.parts);
			}

			line.romanization = romanText;
			if (romanParts.length > 0) line.timedRomanization = romanParts;
		}
	}

	let lyricArray = Array.from(lyrics.values());
	const gapMs = options.instrumentalGapMs ?? DEFAULT_INSTRUMENTAL_GAP_MS;
	if (songDurationMs > 0) {
		lyricArray = insertInstrumentalBreaks(lyricArray, songDurationMs, gapMs);
	}

	return { lyrics: lyricArray, isWordSynced, language: lang };
}

export const TTMLParser: LyricParser = {
	detect(input: string): boolean {
		return input.includes("<tt") && input.includes("</tt>");
	},
	parse(input: string, _duration = 0): Lyric[] {
		const result = parseTTMLContent(input);
		return result.lyrics;
	},
};

export { parseTTMLContent };

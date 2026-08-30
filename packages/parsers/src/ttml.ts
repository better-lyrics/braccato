import { type X2jOptions, XMLParser } from "fast-xml-parser";
import { insertInstrumentalBreaks } from "./instrumentalBreaks.js";
import type {
	MetadataElement,
	ParagraphElementOrBackground,
	SpanElement,
	TranslationContainer,
	TransliterationContainer,
	TtmlRoot,
} from "./ttmlTypes.js";
import type { Lyric, LyricParser, LyricPart } from "./types.js";

/**
 * Parse time in hh:mm:ss.xx or offset-time with unit indicators "h", "m", "s", "ms" (e.g 432.25s)
 */
function parseTime(timeStr: string | number | undefined): number {
	if (!timeStr) return 0;
	if (typeof timeStr === "number") return timeStr;

	const offsetTimeMatch = timeStr.match(/^([\d.]+)(h|m|s|ms)$/);
	if (offsetTimeMatch) {
		const value = Number.parseFloat(offsetTimeMatch[1]);
		const unit = offsetTimeMatch[2];
		if (unit === "h") return Math.round(value * 60 * 60 * 1000);
		if (unit === "m") return Math.round(value * 60 * 1000);
		if (unit === "s") return Math.round(value * 1000);
		if (unit === "ms") return Math.round(value);
	}

	// removes any non-numerical character except dots
	const parts = timeStr.split(":").map((val) => val.replace(/[^0-9.]/g, ""));
	let totalMs = 0;

	try {
		if (parts.length === 1) {
			// Format: ss.mmm
			totalMs = Number.parseFloat(parts[0]) * 1000;
		} else if (parts.length === 2) {
			// Format: mm:ss.mmm
			totalMs = Number.parseInt(parts[0], 10) * 60 * 1000 + Number.parseFloat(parts[1]) * 1000;
		} else if (parts.length === 3) {
			// Format: hh:mm:ss.mmm
			totalMs =
				Number.parseInt(parts[0], 10) * 3600 * 1000 +
				Number.parseInt(parts[1], 10) * 60 * 1000 +
				Number.parseFloat(parts[2]) * 1000;
		}

		return Math.round(totalMs);
	} catch {
		return 0;
	}
}

export { parseTime as parseTTMLTime };

// -- Entity Decoding -----------------------------------

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	quot: '"',
	lt: "<",
	gt: ">",
	nbsp: "\u00A0",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	mdash: "—",
	ndash: "–",
	copy: "©",
	reg: "®",
	trade: "™",
};

/**
 * Decode HTML and XML character references / entities in a text string.
 * Handles hex (e.g. &#x27;), decimal (e.g. &#39;), and named entities (e.g. &apos;, &quot;, &amp;).
 */
function decodeEntities(text: string): string {
	if (typeof text !== "string" || !text.includes("&")) return text;

	return text.replace(/&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z0-9]+));/g, (match, hex, dec, named) => {
		if (hex) {
			const code = Number.parseInt(hex, 16);
			if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return match;
		}
		if (dec) {
			const code = Number.parseInt(dec, 10);
			if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) {
				try {
					return String.fromCodePoint(code);
				} catch {
					return match;
				}
			}
			return match;
		}
		if (named) {
			return NAMED_ENTITIES[named] ?? match;
		}
		return match;
	});
}

// -- Agents --------------------------------------------

function extractAgentMapping(metadataElements: MetadataElement[]): Map<string, string> {
	const mapping = new Map<string, string>();
	if (!metadataElements || metadataElements.length === 0) return mapping;

	const agentElements = metadataElements.filter((e) => "agent" in e && e[":@"]);

	let voiceIndex = 0;
	for (const agent of agentElements) {
		const originalId = agent[":@"]?.["@_id"];
		const agentType = agent[":@"]?.["@_type"];
		if (!originalId) continue;

		if (agentType === "person" || agentType === "character") {
			voiceIndex++;
			mapping.set(originalId, `v${voiceIndex}`);
		} else {
			mapping.set(originalId, "v1000");
		}
	}
	return mapping;
}

// -- Spans --------------------------------------------

interface NestedSpan {
	"#text"?: string;
	span?: NestedSpan[];
}

/**
 * The text of a timed span. Apple and AMLL both put the word straight inside the timed span, but a
 * document that wraps it in a further untimed span is still readable, so the whole subtree counts.
 */
function collectSpanText(children: NestedSpan[] | undefined): string {
	if (!children) return "";
	let text = "";
	for (const child of children) {
		if (typeof child["#text"] === "string") text += decodeEntities(child["#text"]);
		else if (child.span) text += collectSpanText(child.span);
	}
	return text;
}

function parseLyricPart(
	paragraph: ParagraphElementOrBackground[],
	beginTime: number,
): { parts: LyricPart[]; text: string; isWordSynced: boolean } {
	let text = "";
	let parts: LyricPart[] = [];
	let isWordSynced = false;

	for (const element of paragraph) {
		let isBackground = false;
		let localP: SpanElement[] = [element];

		if (element[":@"]?.["@_role"] === "x-bg") {
			// traverse one span in. This is a bg lyric
			isBackground = true;
			localP = element.span ?? [];
		}

		for (const subPart of localP) {
			if (subPart["#text"]) {
				const decodedText = decodeEntities(subPart["#text"]);
				text += decodedText;
				const lastPart = parts[parts.length - 1];

				parts.push({
					startTimeMs: lastPart ? lastPart.startTimeMs + lastPart.durationMs : beginTime,
					durationMs: 0,
					words: decodedText,
					isBackground,
				});
			} else if (subPart.span) {
				const spanText = collectSpanText(subPart.span);
				if (!spanText) continue;

				const startTimeMs = parseTime(subPart[":@"]?.["@_begin"]);
				const endTimeMs = parseTime(subPart[":@"]?.["@_end"]);
				const explicit = subPart[":@"]?.["@_explicit"] === "true" || subPart[":@"]?.["@_obscene"] === "true";

				parts.push({
					startTimeMs,
					durationMs: endTimeMs - startTimeMs,
					isBackground,
					words: spanText,
					explicit,
				});
				text += spanText;

				isWordSynced = true;
			}
		}
	}

	if (!isWordSynced) {
		parts = [];
	}

	return { parts, text, isWordSynced };
}

// -- AMLL TTML Namespace Recovery --------------------------------------------
// Some exporters (AMLL, etc.) use prefixes without declaring them; inject synthetic xmlns to keep parsers happy.

const ELEMENT_PREFIX_REGEX = /<\/?([A-Za-z][\w.-]*):/g;
const ATTRIBUTE_PREFIX_REGEX = /\s([A-Za-z][\w.-]*):[\w.-]+\s*=/g;
const DECLARED_PREFIX_REGEX = /xmlns:([A-Za-z][\w.-]*)\s*=/g;
const ROOT_TT_TAG_REGEX = /<tt\b[^>]*>/;

function declareMissingNamespaces(content: string): string {
	const rootMatch = content.match(ROOT_TT_TAG_REGEX);
	if (!rootMatch) return content;

	const rootTag = rootMatch[0];
	const declared = new Set<string>(["xml", "xmlns"]);
	for (const match of rootTag.matchAll(DECLARED_PREFIX_REGEX)) {
		declared.add(match[1]);
	}

	const used = new Set<string>();
	for (const match of content.matchAll(ELEMENT_PREFIX_REGEX)) {
		used.add(match[1]);
	}
	for (const match of content.matchAll(ATTRIBUTE_PREFIX_REGEX)) {
		used.add(match[1]);
	}

	const missing = [...used].filter((prefix) => !declared.has(prefix));
	if (missing.length === 0) return content;

	const additions = missing.map((prefix) => ` xmlns:${prefix}="urn:braccato:unbound:${prefix}"`).join("");
	const patchedRootTag = rootTag.replace(/>$/, `${additions}>`);
	return content.replace(rootTag, patchedRootTag);
}

// -- Parser --------------------------------------------

const PARSER_OPTIONS: X2jOptions = {
	ignoreAttributes: false,
	attributeNamePrefix: "@_",
	attributesGroupName: false,
	textNodeName: "#text",
	trimValues: false,
	removeNSPrefix: true,
	preserveOrder: true,
	allowBooleanAttributes: true,
	parseAttributeValue: false,
	parseTagValue: false,
	tagValueProcessor: (_tagName, tagValue) => decodeEntities(tagValue),
	attributeValueProcessor: (_attrName, attrValue) => decodeEntities(attrValue),
};

export interface ParseTTMLOptions {
	/** Silence longer than this becomes an instrumental line. Defaults to 5000. */
	instrumentalGapMs?: number;
	/** Used for the outro instrumental when the document's `<body>` carries no `dur`. */
	songDurationMs?: number;
}

export interface ParsedTTML {
	lyrics: Lyric[];
	isWordSynced: boolean;
	language?: string;
}

/**
 * Find the `<metadata>` child that holds `key`, either directly or nested one container deep, and
 * return the whole element so both its own attributes and its children are reachable.
 */
function findInMetadata(
	metadataArray: MetadataElement[],
	key: "translations" | "transliterations",
): MetadataElement | null {
	const direct = metadataArray.find((e) => key in e);
	if (direct?.[key]) return direct;

	for (const element of metadataArray) {
		for (const value of Object.values(element)) {
			if (Array.isArray(value)) {
				const nested = value.find((e): e is MetadataElement => typeof e === "object" && e !== null && key in e);
				if (nested?.[key]) return nested;
			}
		}
	}
	return null;
}

export function parseTTMLContent(xml: string, options: ParseTTMLOptions = {}): ParsedTTML {
	const parser = new XMLParser(PARSER_OPTIONS);

	// A TTML document that arrived inside a JSON string keeps its escaped quotes.
	const cleanedXml = xml.replace(/\\"/g, '"');

	// `parse` throws on a document it will not read at all, nesting past its own depth cap among
	// them. The empty result is the only thing this function says about input it cannot use, so a
	// throw says it the same way rather than reaching a caller that has no channel for it.
	let rawObj: TtmlRoot;
	try {
		rawObj = parser.parse(declareMissingNamespaces(cleanedXml)) as TtmlRoot;
	} catch {
		return { lyrics: [], isWordSynced: false };
	}

	const ttContainer = Array.isArray(rawObj) ? rawObj.find((e) => "tt" in e) : undefined;
	const tt = ttContainer?.tt;
	if (!tt) return { lyrics: [], isWordSynced: false };

	const ttHead = tt.find((e) => e.head)?.head;
	const ttBodyContainer = tt.find((e) => e.body);
	const ttBody = ttBodyContainer?.body;
	const ttMeta = ttBodyContainer?.[":@"];

	const language = ttContainer?.[":@"]?.["@_lang"] || ttMeta?.["@_lang"];

	if (!ttBody) return { lyrics: [], isWordSynced: false, language };

	const lyrics = new Map<string, Lyric>();
	const lyricIds: Record<string, string[]> = {};

	const metadataElements = ttHead?.find((e) => "metadata" in e)?.metadata ?? [];
	const agentMapping = extractAgentMapping(metadataElements);

	const lines = ttBody.flatMap((e) => e.div ?? []).filter((e) => e != null && "p" in e);

	const hasTimingData = lines.length > 0 && lines[0][":@"] !== undefined;
	if (!hasTimingData) {
		return { lyrics: [], isWordSynced: false, language };
	}

	let isWordSynced = false;

	for (const line of lines) {
		const meta = line[":@"];
		if (!meta?.["@_begin"]) continue;

		const beginTimeMs = parseTime(meta["@_begin"]);
		const endTimeMs = parseTime(meta["@_end"]);

		const partParse = parseLyricPart(line.p, beginTimeMs);
		if (partParse.isWordSynced) isWordSynced = true;

		const rawAgent = meta["@_agent"];
		const normalizedAgent = rawAgent ? (agentMapping.get(rawAgent) ?? rawAgent) : undefined;

		// A key repeated across lines (a chorus, say) has to stay one entry per line, so each occurrence
		// gets a suffixed id and the key keeps its list of them for translations to fan back out over.
		const rawKey = meta["@_key"];
		let id: string;
		if (rawKey) {
			const seen = lyricIds[rawKey];
			if (seen) seen.push(`${rawKey}_${seen.length + 1}`);
			else lyricIds[rawKey] = [`${rawKey}_1`];
			const ids = lyricIds[rawKey];
			id = ids[ids.length - 1];
		} else {
			id = String(lyrics.size);
		}

		lyrics.set(id, {
			agent: normalizedAgent,
			durationMs: endTimeMs - beginTimeMs,
			parts: partParse.parts,
			startTimeMs: beginTimeMs,
			words: partParse.text,
			key: rawKey ?? id,
		});
	}

	const forEachLineWithKey = (forKey: string, apply: (line: Lyric) => void) => {
		const ids = lyricIds[forKey];
		if (!ids) return;
		for (const id of ids) {
			const line = lyrics.get(id);
			if (line) apply(line);
		}
	};

	// -- Translations --------------------------------------------
	// Two dialects reach this parser. Apple hangs the language off each `<translation>` and the line
	// key off the `<text>` inside it; the dialect this package shipped first hangs the language off
	// `<translations>` and the line key off `<translation>`. Both are read.
	const translationsElement = findInMetadata(metadataElements, "translations");
	if (translationsElement) {
		const outerLang = translationsElement[":@"]?.["@_lang"];
		const containers = (translationsElement.translations ?? []) as TranslationContainer[];

		for (const container of containers) {
			const lang = container[":@"]?.["@_lang"] ?? outerLang;
			const containerFor = container[":@"]?.["@_for"];

			for (const item of container.translation ?? []) {
				const forKey = item[":@"]?.["@_for"] ?? containerFor;
				// The whole subtree, so a `<text>` that wraps its translation in further elements reads
				// the same as a bare one. 0.1.x used textContent and gathered it the same way.
				const text = collectSpanText(item.text);
				if (!lang || !text || !forKey) continue;

				forEachLineWithKey(forKey, (line) => {
					if (!line.translations) line.translations = {};
					line.translations[lang] = text;
					// `translation` predates `translations` in this package's published shape. The first
					// language wins so a consumer reading it keeps getting one stable answer.
					if (!line.translation) line.translation = { text, lang };
				});
			}
		}
	}

	// -- Transliterations --------------------------------------------
	const transliterationsElement = findInMetadata(metadataElements, "transliterations");
	if (transliterationsElement) {
		const containers = (transliterationsElement.transliterations ?? []) as TransliterationContainer[];

		for (const container of containers) {
			for (const item of container.transliteration ?? []) {
				const forKey = item[":@"]?.["@_for"];
				// A `for` also reaches this loop on a child that is not a `<text>`, and that child has no
				// paragraph to read, so the item is passed over rather than parsed.
				const paragraph = item.text;
				if (!forKey || !paragraph) continue;

				forEachLineWithKey(forKey, (line) => {
					const parseResult = parseLyricPart(paragraph, line.startTimeMs);
					line.romanization = parseResult.text;
					if (parseResult.parts.length > 0) line.timedRomanization = parseResult.parts;
				});
			}
		}
	}

	const songDurationMs = ttMeta?.["@_dur"] ? parseTime(ttMeta["@_dur"]) : (options.songDurationMs ?? 0);
	const lyricArray = insertInstrumentalBreaks(Array.from(lyrics.values()), songDurationMs, options.instrumentalGapMs);

	return { lyrics: lyricArray, isWordSynced, language };
}

export const TTMLParser: LyricParser = {
	detect(input: string): boolean {
		return input.includes("<tt") && input.includes("</tt>");
	},
	// The duration is deliberately unused. `@braccato/provider-blyrics` calls this with one argument,
	// and a version that honoured the parameter would hand that call site a 0 song duration.
	parse(input: string, _duration = 0): Lyric[] {
		return parseTTMLContent(input).lyrics;
	},
};

import type { LyricPart, RubySegment } from "@braccato/types";
import { COMMON_ENGLISH_LOANWORDS, COMPOUND_KANJI_MAPPINGS, JUKUJIKUN_WORDS, ROMAJI_TO_HIRAGANA } from "./dictionaries";

export type { RubySegment };

const KANJI_REGEX = /[\p{Script=Han}\u3005]/u;
const ALL_KANJI_REGEX = /^[\p{Script=Han}\u3005]+$/u;
const KANJI_BLOCK_GLOBAL = /(?:[0-9０-９]*[\p{Script=Han}\u3005][0-9０-９\p{Script=Han}\u3005]*)/gu;

export function containsKanji(text: string): boolean {
	return KANJI_REGEX.test(text);
}

function countKanji(text: string): number {
	if (!text) return 0;
	let count = 0;
	for (const ch of text) {
		if (KANJI_REGEX.test(ch)) count++;
	}
	return count;
}

function countKanjiAndNumericUnits(text: string): number {
	if (!text) return 0;
	let count = 0;
	for (const ch of text) {
		if (KANJI_REGEX.test(ch)) count++;
	}
	const digitSequences = text.match(/[0-9０-９]+/g);
	if (digitSequences) {
		count += digitSequences.length;
	}
	return count;
}

export function katakanaToHiragana(text: string): string {
	return text.replace(/[\u30A1-\u30F6]/g, (match) => String.fromCharCode(match.charCodeAt(0) - 0x60));
}

const STRICT_ROMAJI_REGEX =
	/^(?:[aiueo]|k[aiueo]|ky[auo]|s[aiueo]|sh[aiuo]|sy[auo]|t[aiueo]|ch[aiuo]|ts[u]|ty[auo]|n[aiueo]|ny[auo]|h[aiueo]|fu|hy[auo]|m[aiueo]|my[auo]|y[auoe]|r[aiueo]|ry[auo]|w[aeio]|g[aiueo]|gy[auo]|z[aiueo]|j[aiueo]|zy[auo]|d[aiueo]|dy[auo]|b[aiueo]|by[auo]|p[aiueo]|py[auo]|v[aiueo]|n(?![aiueoy])|([ksthcpb])\1)+$/i;

function isStrictRomajiWord(word: string): boolean {
	return STRICT_ROMAJI_REGEX.test(word);
}

export function romajiToHiragana(input: string, keepSpaces = false): string {
	if (!input) return "";

	let str = katakanaToHiragana(input.trim())
		.replace(/[āâ]/g, "aa")
		.replace(/[īî]/g, "ii")
		.replace(/[ūû]/g, "uu")
		.replace(/[ēê]/g, "ee")
		.replace(/[ōô]/g, "ou");

	// Pre-convert unambiguous English loanwords that are not valid Japanese Romaji syllables
	str = str.replace(/\b[a-zA-Z]+(?:'[a-zA-Z]+)?\b/g, (match) => {
		const lower = match.toLowerCase();
		const loan = COMMON_ENGLISH_LOANWORDS[lower];
		if (loan && !isStrictRomajiWord(lower)) {
			return loan;
		}
		return match;
	});

	if (/^[\u3040-\u309F\u30FC\s?!.,~:;？！、。〜：；]+$/u.test(str)) {
		return keepSpaces ? str.replace(/\s+/g, " ") : str.replace(/[\s?!.,~:;？！、。〜：；]+/g, "");
	}

	let result = "";
	let i = 0;
	const len = str.length;
	const lowerStr = str.toLowerCase();

	while (i < len) {
		const ch = str[i];

		if ((ch >= "\u3040" && ch <= "\u309F") || ch === "\u30FC") {
			result += ch;
			i++;
			continue;
		}

		if (/\s/.test(ch)) {
			if (keepSpaces && !result.endsWith(" ")) {
				result += " ";
			}
			i++;
			continue;
		}

		if (keepSpaces && /[?!.,~:;？！、。〜：；]/.test(ch)) {
			result += ch;
			i++;
			continue;
		}

		if (/[^a-z]/i.test(ch)) {
			i++;
			continue;
		}

		const lowerCh = lowerStr[i];

		if (
			i + 1 < len &&
			lowerCh === lowerStr[i + 1] &&
			/[bcdfghjklmpqrstvwxyz]/i.test(lowerCh) &&
			lowerCh !== "n" &&
			lowerCh !== "m"
		) {
			result += "っ";
			i++;
			continue;
		}

		if (i + 2 < len && (lowerStr.slice(i, i + 3) === "tch" || lowerStr.slice(i, i + 3) === "cch")) {
			result += "っ";
			i++;
			continue;
		}

		// In Sino-Japanese phonology, post-vocalic 'ny*' represents syllabic 'n' + 'y*', excluding mimetic words
		if (
			lowerCh === "n" &&
			(lowerStr.slice(i, i + 3) === "nya" || lowerStr.slice(i, i + 3) === "nyu" || lowerStr.slice(i, i + 3) === "nyo")
		) {
			const isMimeticNya = i >= 2 && /^(?:gunya|munya|funya|honyara)/i.test(lowerStr.slice(i - 2));
			const prevCh = i > 0 ? lowerStr[i - 1] : "";
			if (!isMimeticNya && /[aeiou]/i.test(prevCh)) {
				result += "ん";
				i++;
				continue;
			}
		}

		if (i + 3 <= len) {
			const sub3 = lowerStr.slice(i, i + 3);
			if (ROMAJI_TO_HIRAGANA[sub3]) {
				result += ROMAJI_TO_HIRAGANA[sub3];
				i += 3;
				continue;
			}
		}

		if (i + 2 <= len) {
			const sub2 = lowerStr.slice(i, i + 2);
			if (ROMAJI_TO_HIRAGANA[sub2]) {
				result += ROMAJI_TO_HIRAGANA[sub2];
				i += 2;
				continue;
			}
		}

		// Syllabic 'm' before b, p, m (Traditional Hepburn: e.g., shimbun, kampai, sempai)
		if (lowerCh === "m" && i + 1 < len && /[bpm]/i.test(lowerStr[i + 1])) {
			result += "ん";
			i++;
			continue;
		}

		if (lowerCh === "n") {
			const next = lowerStr[i + 1];
			if (!next || /[^aeiouy]/i.test(next)) {
				result += "ん";
				if (next === "'" || next === "’" || next === "-") i++;
				i++;
				continue;
			}
		}

		if (ROMAJI_TO_HIRAGANA[lowerCh]) {
			result += ROMAJI_TO_HIRAGANA[lowerCh];
			i++;
			continue;
		}

		if (i === len - 1 && /[bcdfghjklmpqrstvwxyz]/i.test(lowerCh) && lowerCh !== "n" && !result.endsWith("っ")) {
			result += "っ";
			i++;
			continue;
		}

		i++;
	}

	return result;
}

function normalizeSmallKana(ch: string): string {
	switch (ch) {
		case "ぁ":
		case "ァ":
			return "あ";
		case "ぃ":
		case "ィ":
			return "い";
		case "ぅ":
		case "ゥ":
			return "う";
		case "ぇ":
		case "ェ":
			return "え";
		case "ぉ":
		case "ォ":
			return "お";
		case "ゎ":
		case "ヮ":
			return "わ";
		case "ヵ":
			return "か";
		case "ヶ":
			return "け";
		default:
			return ch;
	}
}

function areKanaEquivalent(textKana: string, readingKana: string): boolean {
	if (textKana === readingKana) return true;

	const hText = katakanaToHiragana(textKana);
	const hReading = katakanaToHiragana(readingKana);
	if (hText === hReading) return true;

	const normText = normalizeSmallKana(hText);
	const normReading = normalizeSmallKana(hReading);
	if (normText === normReading) return true;

	if (normText === "は" && normReading === "わ") return true;
	if (normText === "わ" && normReading === "は") return true;
	if (normText === "を" && normReading === "お") return true;
	if (normText === "お" && normReading === "を") return true;
	if (normText === "へ" && normReading === "え") return true;
	if (normText === "え" && normReading === "へ") return true;
	if ((normText === "づ" && normReading === "ず") || (normText === "ず" && normReading === "づ")) return true;
	if ((normText === "ぢ" && normReading === "じ") || (normText === "じ" && normReading === "ぢ")) return true;
	const VOWELS_FOR_CHOON = new Set(["あ", "い", "う", "え", "お"]);
	if (normText === "ー" && VOWELS_FOR_CHOON.has(normReading)) return true;
	if (normReading === "ー" && VOWELS_FOR_CHOON.has(normText)) return true;
	return false;
}

function cleanRuby(ruby: string): string {
	if (!ruby) return "";
	let kana = ruby;
	if (/[a-zA-Z]/.test(kana)) {
		kana = romajiToHiragana(kana);
	}
	return kana
		.replace(
			/^[^\p{Script=Hiragana}\p{Script=Katakana}\u30FC]+|[^\p{Script=Hiragana}\p{Script=Katakana}\u30FC]+$/gu,
			"",
		)
		.replace(/\s+/g, "")
		.trim();
}

interface KanaAnchor {
	pos: number;
	len: number;
}

export function normalizePunctuation(str: string): string {
	return str
		.replace(/？/g, "?")
		.replace(/！/g, "!")
		.replace(/：/g, ":")
		.replace(/；/g, ";")
		.replace(/[，、]/g, ",")
		.replace(/[。]/g, ".")
		.replace(/[〜～]/g, "~")
		.replace(/\u3000/g, " ");
}

function findKanaAnchor(
	haystack: string,
	needle: string,
	startIndex = 0,
	expectedNextKana?: string,
): KanaAnchor | null {
	if (!needle || !needle.trim()) return null;

	if (/[a-zA-Z]/.test(needle) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(needle)) {
		const lowerHaystack = haystack.toLowerCase();
		const lowerNeedle = needle.toLowerCase();
		const lowerDirectIdx = lowerHaystack.indexOf(lowerNeedle, startIndex);
		if (lowerDirectIdx !== -1) {
			return { pos: lowerDirectIdx, len: needle.length };
		}
	}

	// Phonetic kana match respecting particle pronunciation and lookahead guard
	let needleKana = katakanaToHiragana(
		needle.replace(/[^\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\u30FC]/gu, ""),
	);
	if (/[a-zA-Z]/.test(needleKana)) {
		needleKana = romajiToHiragana(needleKana);
	}

	let phoneticAnchor: KanaAnchor | null = null;
	if (needleKana) {
		const needleLen = needleKana.length;
		const hasSpaces = haystack.includes(" ");
		let fullBoundaryAnchor: KanaAnchor | null = null;
		let firstCandidate: KanaAnchor | null = null;

		for (let i = startIndex; i < haystack.length; i++) {
			if (/\s/.test(haystack[i])) continue;

			let match = true;
			let hIdx = i;
			let kIdx = 0;

			while (kIdx < needleLen && hIdx < haystack.length) {
				if (/\s/.test(haystack[hIdx])) {
					hIdx++;
					continue;
				}
				if (!areKanaEquivalent(haystack[hIdx], needleKana[kIdx])) {
					match = false;
					break;
				}
				hIdx++;
				kIdx++;
			}

			if (match && kIdx === needleLen) {
				// Lookahead check: verify that candidate match does not cut a word in half
				if (expectedNextKana) {
					let afterIdx = hIdx;
					while (afterIdx < haystack.length && /[\s?!.,~:;？！、。〜：；]/.test(haystack[afterIdx])) {
						afterIdx++;
					}
					if (afterIdx < haystack.length && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(haystack[afterIdx])) {
						const nextHaystackKana = katakanaToHiragana(haystack[afterIdx]);
						if (!areKanaEquivalent(nextHaystackKana, expectedNextKana)) {
							continue;
						}
					}
				}

				// Prioritize full boundary match with whitespace/punctuation on both sides
				const atLeadingBoundary = i === 0 || /[\s?!.,~:;？！、。〜：；]/.test(haystack[i - 1]);
				const atTrailingBoundary = hIdx === haystack.length || /[\s?!.,~:;？！、。〜：；]/.test(haystack[hIdx]);
				const isFullBoundary = atLeadingBoundary && atTrailingBoundary;

				if (isFullBoundary) {
					fullBoundaryAnchor = { pos: i, len: hIdx - i };
					break;
				}

				if (!firstCandidate) {
					firstCandidate = { pos: i, len: hIdx - i };
				}

				// If haystack has spaces, scan up to 6 characters ahead for a possible fullBoundaryAnchor
				if (hasSpaces && i > startIndex + 6) {
					break;
				}
			}
		}

		phoneticAnchor = fullBoundaryAnchor || firstCandidate;
	}

	const directIdx = haystack.indexOf(needle, startIndex);
	if (directIdx !== -1) {
		if (!phoneticAnchor) {
			if (expectedNextKana) {
				let afterIdx = directIdx + needle.length;
				while (afterIdx < haystack.length && /[\s?!.,~:;？！、。〜：；]/.test(haystack[afterIdx])) {
					afterIdx++;
				}
				if (afterIdx < haystack.length && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(haystack[afterIdx])) {
					const nextHaystackKana = katakanaToHiragana(haystack[afterIdx]);
					if (!areKanaEquivalent(nextHaystackKana, expectedNextKana)) {
						return null;
					}
				}
			}
			return { pos: directIdx, len: needle.length };
		}
		// Only allow direct match to override phonetic anchor if needle contains punctuation/symbols/brackets
		// and matches earlier; for pure kana needles, the boundary-aware phonetic match takes precedence.
		if (/[\p{Punctuation}\p{Symbol}]/u.test(needle) && directIdx <= phoneticAnchor.pos) {
			return { pos: directIdx, len: needle.length };
		}
	}

	if (phoneticAnchor) {
		return phoneticAnchor;
	}

	const normHaystack = normalizePunctuation(haystack);
	const normNeedle = normalizePunctuation(needle);
	if (normHaystack !== haystack || normNeedle !== needle) {
		const normIdx = normHaystack.indexOf(normNeedle, startIndex);
		if (normIdx !== -1) return { pos: normIdx, len: needle.length };
	}

	const trimmedNeedle = normNeedle.trim();
	if (trimmedNeedle && trimmedNeedle !== normNeedle) {
		const trimmedIdx = normHaystack.indexOf(trimmedNeedle, startIndex);
		if (trimmedIdx !== -1) return { pos: trimmedIdx, len: trimmedNeedle.length };
	}

	const lowerHaystack = haystack.toLowerCase();
	const lowerNeedle = needle.toLowerCase();
	const lowerDirectIdx = lowerHaystack.indexOf(lowerNeedle, startIndex);
	if (lowerDirectIdx !== -1) return { pos: lowerDirectIdx, len: needle.length };

	return null;
}

function findAllKanaAnchors(haystack: string, needle: string, startIndex = 0, expectedNextKana?: string): KanaAnchor[] {
	if (!needle || !needle.trim()) return [];

	if (/[a-zA-Z]/.test(needle) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(needle)) {
		const lowerHaystack = haystack.toLowerCase();
		const lowerNeedle = needle.toLowerCase();
		const results: KanaAnchor[] = [];
		let idx = lowerHaystack.indexOf(lowerNeedle, startIndex);
		while (idx !== -1) {
			results.push({ pos: idx, len: needle.length });
			idx = lowerHaystack.indexOf(lowerNeedle, idx + needle.length);
		}
		return results;
	}

	let needleKana = katakanaToHiragana(
		needle.replace(/[^\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\u30FC]/gu, ""),
	);
	if (/[a-zA-Z]/.test(needleKana)) {
		needleKana = romajiToHiragana(needleKana);
	}

	interface ScoredKanaAnchor extends KanaAnchor {
		isFullBoundary?: boolean;
	}
	const results: ScoredKanaAnchor[] = [];
	if (needleKana) {
		const needleLen = needleKana.length;
		for (let i = startIndex; i < haystack.length; i++) {
			if (/\s/.test(haystack[i])) continue;

			let match = true;
			let hIdx = i;
			let kIdx = 0;

			while (kIdx < needleLen && hIdx < haystack.length) {
				if (/\s/.test(haystack[hIdx])) {
					hIdx++;
					continue;
				}
				if (!areKanaEquivalent(haystack[hIdx], needleKana[kIdx])) {
					match = false;
					break;
				}
				hIdx++;
				kIdx++;
			}

			if (match && kIdx === needleLen) {
				if (expectedNextKana) {
					let afterIdx = hIdx;
					while (afterIdx < haystack.length && /[\s?!.,~:;？！、。〜：；]/.test(haystack[afterIdx])) {
						afterIdx++;
					}
					if (afterIdx < haystack.length && /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(haystack[afterIdx])) {
						const nextHaystackKana = katakanaToHiragana(haystack[afterIdx]);
						if (!areKanaEquivalent(nextHaystackKana, expectedNextKana)) {
							continue;
						}
					}
				}
				const atLeadingBoundary = i === 0 || /[\s?!.,~:;？！、。〜：；]/.test(haystack[i - 1]);
				const atTrailingBoundary = hIdx === haystack.length || /[\s?!.,~:;？！、。〜：；]/.test(haystack[hIdx]);
				const isFullBoundary = atLeadingBoundary && atTrailingBoundary;
				results.push({ pos: i, len: hIdx - i, isFullBoundary });
			}
		}

		if (results.some((r) => r.isFullBoundary)) {
			results.sort((a, b) => {
				if (a.isFullBoundary && !b.isFullBoundary) return -1;
				if (!a.isFullBoundary && b.isFullBoundary) return 1;
				return a.pos - b.pos;
			});
		}
	}

	if (results.length === 0) {
		const direct = findKanaAnchor(haystack, needle, startIndex, expectedNextKana);
		if (direct) results.push(direct);
	}

	return results;
}

// Only checks Hiragana because Katakana loanwords can have vowel divergence from romaji (e.g. game -> がめ vs ゲーム).
function getNextExpectedKana(
	tokens: { text: string; isKanji: boolean }[],
	tokenIdx: number,
	offsetInTokenText: number,
): string | undefined {
	const getFirstKana = (str: string): string | undefined => {
		const trimmed = str.replace(/^[\s?!.,~:;？！、。〜：；]+/, "");
		if (!trimmed) return undefined;
		if (/^\p{Script=Hiragana}/u.test(trimmed)) {
			return trimmed[0];
		}
		return undefined;
	};

	const local = getFirstKana(tokens[tokenIdx].text.slice(offsetInTokenText));
	if (local) return local;

	if (!tokens[tokenIdx].text.slice(offsetInTokenText).trim()) {
		for (let k = tokenIdx + 1; k < tokens.length; k++) {
			if (!tokens[k].isKanji) {
				const next = getFirstKana(tokens[k].text);
				if (next) return next;
				if (tokens[k].text.trim()) break;
			} else {
				break;
			}
		}
	}
	return undefined;
}

const BRACKETED_KANJI_GLOBAL = /([\p{Script=Han}\u3005]+)[（(]([\u3040-\u309F\u30A0-\u30FF\u30FC]+)[）)]/gu;

export function alignLineByKanaAnchors(lineText: string, readingHiragana: string): RubySegment[] {
	if (!lineText || !containsKanji(lineText) || !readingHiragana) {
		return [{ text: lineText }];
	}

	interface Token {
		text: string;
		isKanji: boolean;
		bracketKana?: string;
	}
	const tokens: Token[] = [];

	const bracketMatches: { text: string; kanji: string; kana: string; start: number; end: number }[] = [];
	for (const bm of lineText.matchAll(BRACKETED_KANJI_GLOBAL)) {
		bracketMatches.push({
			text: bm[0],
			kanji: bm[1],
			kana: katakanaToHiragana(bm[2]),
			start: bm.index,
			end: bm.index + bm[0].length,
		});
	}

	const tokenizeSlice = (slice: string) => {
		let textIdx = 0;
		for (const m of slice.matchAll(KANJI_BLOCK_GLOBAL)) {
			if (m.index > textIdx) {
				tokens.push({ text: slice.slice(textIdx, m.index), isKanji: false });
			}
			tokens.push({ text: m[0], isKanji: true });
			textIdx = m.index + m[0].length;
		}
		if (textIdx < slice.length) {
			tokens.push({ text: slice.slice(textIdx), isKanji: false });
		}
	};

	let textIdx = 0;
	for (const b of bracketMatches) {
		if (b.start > textIdx) {
			tokenizeSlice(lineText.slice(textIdx, b.start));
		}
		tokens.push({
			text: b.text,
			isKanji: true,
			bracketKana: b.kana,
		});
		textIdx = b.end;
	}
	if (textIdx < lineText.length) {
		tokenizeSlice(lineText.slice(textIdx));
	}

	const result: RubySegment[] = [];
	let readingCursor = 0;
	const normalizedReading = katakanaToHiragana(readingHiragana);

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];

		while (
			readingCursor < normalizedReading.length &&
			(/\s/.test(normalizedReading[readingCursor]) ||
				(token.isKanji && /[\s?!.,~:;？！、。〜：；]/.test(normalizedReading[readingCursor])))
		) {
			readingCursor++;
		}

		// If Kanji(kana) bracketed reading: when reading has no brackets and matches bracketKana,
		// treat as an atomic unit: consume reading, preserve text without ruby or absorption.
		if (token.bracketKana) {
			const anchor = !/[()（）]/.test(readingHiragana)
				? findKanaAnchor(normalizedReading, token.bracketKana, readingCursor)
				: null;
			if (anchor && anchor.pos >= readingCursor && anchor.pos <= readingCursor + 4) {
				readingCursor = anchor.pos + anchor.len;
			}
			result.push({ text: token.text });
			continue;
		}

		if (!token.isKanji) {
			result.push({ text: token.text });
			if (!token.text.trim()) {
				continue;
			}
			const nextKanaAfterToken = getNextExpectedKana(tokens, i, token.text.length);
			const fullAnchor = findKanaAnchor(normalizedReading, token.text, readingCursor, nextKanaAfterToken);
			if (fullAnchor) {
				readingCursor = fullAnchor.pos + fullAnchor.len;
			} else {
				const words =
					token.text.match(
						/\p{Script=Hiragana}+|[\p{Script=Katakana}\u30FC]+|[A-Za-z0-9'’\-]+|[?!.,~:;？！、。〜：；]+/gu,
					) || [];
				let wordOffset = 0;
				for (const w of words) {
					const wIdx = token.text.indexOf(w, wordOffset);
					wordOffset = (wIdx !== -1 ? wIdx : wordOffset) + w.length;
					const nextKanaAfterWord = getNextExpectedKana(tokens, i, wordOffset);
					const wAnchor = findKanaAnchor(normalizedReading, w, readingCursor, nextKanaAfterWord);
					if (wAnchor) {
						readingCursor = wAnchor.pos + wAnchor.len;
					}
				}
			}
		} else {
			const normToken = token.text.normalize("NFKC");
			const dictMapping = COMPOUND_KANJI_MAPPINGS[token.text] || COMPOUND_KANJI_MAPPINGS[normToken];
			const minKanjiMora = dictMapping ? dictMapping.join("").length : countKanjiAndNumericUnits(token.text);
			let minLookaheadPos = readingCursor;
			let morasSeen = 0;
			while (minLookaheadPos < normalizedReading.length && morasSeen < minKanjiMora) {
				if (/[\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\u30FC]/u.test(normalizedReading[minLookaheadPos])) {
					morasSeen++;
				}
				minLookaheadPos++;
			}

			let nextAnchorPos = -1;
			for (let j = i + 1; j < tokens.length; j++) {
				if (tokens[j].isKanji) {
					if (tokens[j].bracketKana) {
						const anchor = findKanaAnchor(normalizedReading, tokens[j].bracketKana!, minLookaheadPos);
						if (anchor && anchor.pos >= minLookaheadPos) {
							const candidate = cleanRuby(normalizedReading.slice(readingCursor, anchor.pos));
							if (!candidate || isPlausibleRuby(token.text, candidate)) {
								nextAnchorPos = anchor.pos;
							}
						}
					}
					break;
				}

				const nextKanaAfterToken = getNextExpectedKana(tokens, j, tokens[j].text.length);
				const candidateAnchors = findAllKanaAnchors(
					normalizedReading,
					tokens[j].text,
					minLookaheadPos,
					nextKanaAfterToken,
				);
				for (const fullAnchor of candidateAnchors) {
					if (fullAnchor.pos < minLookaheadPos) continue;
					const candidate = cleanRuby(normalizedReading.slice(readingCursor, fullAnchor.pos));
					if (!candidate || !isPlausibleRuby(token.text, candidate)) continue;

					// Lookahead validation on subsequent kanji token: verify intermediate reading is plausible
					let isSubsequentValid = true;
					for (let k = j + 1; k < tokens.length; k++) {
						if (tokens[k].isKanji) {
							const nextKanji = tokens[k];
							const afterAnchorPos = fullAnchor.pos + fullAnchor.len;
							for (let m = k + 1; m < tokens.length; m++) {
								if (!tokens[m].isKanji) {
									const subAnchors = findAllKanaAnchors(normalizedReading, tokens[m].text, afterAnchorPos);
									if (subAnchors.length > 0) {
										const nextRuby = cleanRuby(normalizedReading.slice(afterAnchorPos, subAnchors[0].pos));
										const hasOkurigana =
											m === k + 1 && /^[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tokens[m].text);
										if (nextRuby && !isPlausibleRuby(nextKanji.text, nextRuby, hasOkurigana)) {
											isSubsequentValid = false;
										}
									}
									break;
								}
							}
							break;
						}
					}

					if (isSubsequentValid) {
						nextAnchorPos = fullAnchor.pos;
						break;
					}
				}
				if (nextAnchorPos >= minLookaheadPos) break;

				const words =
					tokens[j].text.match(
						/\p{Script=Hiragana}+|[\p{Script=Katakana}\u30FC]+|[A-Za-z0-9'’\-]+|[?!.,~:;？！、。〜：；]+/gu,
					) || [];

				let wordOffset = 0;
				for (const word of words) {
					const wordIdxInText = tokens[j].text.indexOf(word, wordOffset);
					wordOffset = (wordIdxInText !== -1 ? wordIdxInText : wordOffset) + word.length;
					const nextKanaAfterWord = getNextExpectedKana(tokens, j, wordOffset);
					const candidateWordAnchors = findAllKanaAnchors(normalizedReading, word, minLookaheadPos, nextKanaAfterWord);
					for (const firstAnchor of candidateWordAnchors) {
						if (firstAnchor.pos < minLookaheadPos) continue;
						const candidate = cleanRuby(normalizedReading.slice(readingCursor, firstAnchor.pos));
						if (!candidate || !isPlausibleRuby(token.text, candidate)) continue;

						let isSubsequentValid = true;
						for (let k = j + 1; k < tokens.length; k++) {
							if (tokens[k].isKanji) {
								const nextKanji = tokens[k];
								const afterAnchorPos = firstAnchor.pos + firstAnchor.len;
								for (let m = k + 1; m < tokens.length; m++) {
									if (!tokens[m].isKanji) {
										const subAnchors = findAllKanaAnchors(normalizedReading, tokens[m].text, afterAnchorPos);
										if (subAnchors.length > 0) {
											const nextRuby = cleanRuby(normalizedReading.slice(afterAnchorPos, subAnchors[0].pos));
											const hasOkurigana =
												m === k + 1 && /^[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tokens[m].text);
											if (nextRuby && !isPlausibleRuby(nextKanji.text, nextRuby, hasOkurigana)) {
												isSubsequentValid = false;
											}
										}
										break;
									}
								}
								break;
							}
						}

						if (isSubsequentValid) {
							nextAnchorPos = firstAnchor.pos;
							break;
						}
					}
					if (nextAnchorPos >= minLookaheadPos) break;
				}
				if (nextAnchorPos >= minLookaheadPos) break;

				// Fallback: If token has punctuation or whitespace, look for the next word boundary (space/punctuation) in reading
				if (/[\s?!.,~:;？！、。〜：；]/.test(tokens[j].text)) {
					let searchPos = minLookaheadPos;
					let bestBoundaryIdx = -1;
					let bestDiff = Number.POSITIVE_INFINITY;

					let remainingKanji = 0;
					let remainingNonKanjiLen = 0;
					for (let k = j + 1; k < tokens.length; k++) {
						if (tokens[k].isKanji) {
							remainingKanji += countKanjiAndNumericUnits(tokens[k].text);
						} else {
							remainingNonKanjiLen += tokens[k].text.trim().length;
						}
					}

					while (searchPos < normalizedReading.length) {
						const relIdx = normalizedReading.slice(searchPos).search(/[\s?!.,~:;？！、。〜：；]/);
						if (relIdx === -1) break;
						const boundaryIdx = searchPos + relIdx;
						const candidate = cleanRuby(normalizedReading.slice(readingCursor, boundaryIdx));
						if (candidate && isPlausibleRuby(token.text, candidate)) {
							if (remainingKanji > 0) {
								const remainingKanaLen = cleanRuby(normalizedReading.slice(boundaryIdx)).length;
								const minRemainingKana = remainingKanji;
								const maxRemainingKana = (remainingKanji === 1 ? 4 : remainingKanji * 3) + remainingNonKanjiLen * 2;
								if (remainingKanaLen >= minRemainingKana && remainingKanaLen <= maxRemainingKana) {
									const currentKanji = countKanjiAndNumericUnits(token.text);
									const totalKanji = currentKanji + remainingKanji;
									const totalKana = candidate.length + remainingKanaLen;
									const idealCandidateLen = totalKana * (currentKanji / totalKanji);
									const diff = Math.abs(candidate.length - idealCandidateLen);
									if (diff < bestDiff) {
										bestDiff = diff;
										bestBoundaryIdx = boundaryIdx;
									}
								}
							} else {
								bestBoundaryIdx = boundaryIdx;
								break;
							}
						}
						searchPos = boundaryIdx + 1;
					}

					if (bestBoundaryIdx !== -1) {
						nextAnchorPos = bestBoundaryIdx;
						break;
					}
				}
			}

			if (nextAnchorPos > readingCursor) {
				const matchedReading = cleanRuby(normalizedReading.slice(readingCursor, nextAnchorPos));
				if (matchedReading && isPlausibleRuby(token.text, matchedReading)) {
					const normKey = token.text.normalize("NFKC");
					const dictMapping = COMPOUND_KANJI_MAPPINGS[token.text] || COMPOUND_KANJI_MAPPINGS[normKey];
					if (dictMapping && dictMapping.join("") !== matchedReading) {
						result.push({ text: token.text });
					} else {
						const rawMatched = normalizedReading.slice(readingCursor, nextAnchorPos).trim();
						const spaceWords = rawMatched.split(/\s+/).filter(Boolean);
						const isNounPlusOkuriganaKanji =
							spaceWords.length > 1 &&
							ALL_KANJI_REGEX.test(token.text) &&
							token.text.length >= 2 &&
							i + 1 < tokens.length &&
							!tokens[i + 1].isKanji &&
							/^[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(tokens[i + 1].text) &&
							isPlausibleRuby(token.text.slice(-1), cleanRuby(spaceWords[spaceWords.length - 1]), true) &&
							isPlausibleRuby(token.text.slice(0, -1), spaceWords.slice(0, -1).map(cleanRuby).join(""));

						if (isNounPlusOkuriganaKanji) {
							const prefixText = token.text.slice(0, -1);
							const prefixRuby = spaceWords.slice(0, -1).map(cleanRuby).join("");
							const lastKanji = token.text.slice(-1);
							const lastRuby = cleanRuby(spaceWords[spaceWords.length - 1]);
							const subSplit = splitKanjiCompoundBySyllables(prefixText, prefixRuby);
							if (subSplit && subSplit.length === prefixText.length) {
								result.push(...Array.from(prefixText).map((ch, idx) => ({ text: ch, ruby: subSplit[idx] })));
							} else {
								result.push({ text: prefixText, ruby: prefixRuby });
							}
							result.push({ text: lastKanji, ruby: lastRuby });
						} else {
							const splitReadings = splitKanjiCompoundBySyllables(token.text, matchedReading);
							if (splitReadings && splitReadings.length === token.text.length) {
								result.push(...Array.from(token.text).map((ch, idx) => ({ text: ch, ruby: splitReadings[idx] })));
							} else {
								result.push({ text: token.text, ruby: matchedReading });
							}
						}
					}
				} else {
					result.push({ text: token.text });
				}
				readingCursor = nextAnchorPos;
			} else {
				const remainingReading = cleanRuby(normalizedReading.slice(readingCursor));
				if (remainingReading && isPlausibleRuby(token.text, remainingReading)) {
					const normKey = token.text.normalize("NFKC");
					const dictMapping = COMPOUND_KANJI_MAPPINGS[token.text] || COMPOUND_KANJI_MAPPINGS[normKey];
					if (dictMapping && dictMapping.join("") !== remainingReading) {
						result.push({ text: token.text });
					} else {
						const splitReadings = splitKanjiCompoundBySyllables(token.text, remainingReading);
						if (splitReadings && splitReadings.length === token.text.length) {
							result.push(...Array.from(token.text).map((ch, idx) => ({ text: ch, ruby: splitReadings[idx] })));
						} else {
							result.push({ text: token.text, ruby: remainingReading });
						}
					}
					readingCursor = normalizedReading.length;
				} else {
					result.push({ text: token.text });
				}
			}
		}
	}

	const normalized = normalizeRubySegments(result);
	if (!isLineAlignmentValid(normalized)) {
		return [{ text: lineText }];
	}
	return normalized;
}

export function alignWordWithReading(word: string, readingRomajiOrKana: string): RubySegment[] {
	if (!word || !containsKanji(word)) {
		return [{ text: word }];
	}

	const readingHiragana = romajiToHiragana(readingRomajiOrKana);
	if (!readingHiragana) {
		return [{ text: word }];
	}

	const prefixMatch = word.match(
		/^[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\p{Letter}\p{Number}]+/u,
	);
	const prefix = prefixMatch ? prefixMatch[0] : "";
	const suffixMatch = word.match(
		/[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\u3005\p{Letter}\p{Number}]+$/u,
	);
	const suffix = suffixMatch ? suffixMatch[0] : "";
	const coreWord = word.slice(prefix.length, word.length - suffix.length);

	if (coreWord && containsKanji(coreWord)) {
		let coreSegs: RubySegment[];
		if (!/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(coreWord)) {
			const splitReadings = splitKanjiCompoundBySyllables(coreWord, readingHiragana);
			if (splitReadings && splitReadings.length === coreWord.length) {
				coreSegs = Array.from(coreWord).map((ch, idx) => ({ text: ch, ruby: splitReadings[idx] }));
			} else {
				coreSegs = [{ text: coreWord, ruby: readingHiragana }];
			}
		} else {
			coreSegs = alignLineByKanaAnchors(coreWord, readingHiragana);
		}
		const result: RubySegment[] = [];
		if (prefix) result.push({ text: prefix });
		result.push(...coreSegs);
		if (suffix) result.push({ text: suffix });
		return normalizeRubySegments(result);
	}

	return [{ text: word }];
}

// Normalizes modern Japanese historical/orthographic kana readings (現代仮名遣い) to prevent Hepburn/macron distortions.
function normalizeOrthographicRuby(kanji: string, ruby: string): string {
	if (!kanji || !ruby) return ruby;

	if (kanji.startsWith("続") && ruby.startsWith("つず")) {
		return ruby.replace(/^つず/, "つづ");
	}
	if (kanji.startsWith("遠") && ruby.startsWith("とう")) {
		return ruby.replace(/^とう/, "とお");
	}
	if (kanji.startsWith("大") && ruby.startsWith("おう")) {
		return ruby.replace(/^おう/, "おお");
	}
	if (kanji.startsWith("多") && ruby.startsWith("おう")) {
		return ruby.replace(/^おう/, "おお");
	}
	if (kanji.startsWith("通") && ruby.startsWith("とう")) {
		return ruby.replace(/^とう/, "とお");
	}
	if (kanji === "氷" && (ruby === "こうり" || ruby === "こおり")) {
		return "こおり";
	}
	if (kanji === "炎" && (ruby === "ほのう" || ruby === "ほのお")) {
		return "ほのお";
	}
	if (kanji === "狼" && (ruby === "おうかみ" || ruby === "おおかみ")) {
		return "おおかみ";
	}
	if (kanji.startsWith("凍") && ruby.startsWith("こう")) {
		return ruby.replace(/^こう/, "こお");
	}
	if (kanji.startsWith("覆") && ruby.startsWith("おう")) {
		return ruby.replace(/^おう/, "おお");
	}
	if (kanji === "付" && ruby === "ず") {
		return "づ";
	}
	if (kanji === "気付" && ruby === "きず") {
		return "きづ";
	}
	if (kanji === "近" && ruby === "ちかず") {
		return "ちかづ";
	}
	if (kanji.startsWith("縮") && ruby.startsWith("ちじ")) {
		return ruby.replace(/^ちじ/, "ちぢ");
	}

	// Kanji readings never use the grammatical particle "を".
	// Romanized "wo" mapped to Kanji (e.g. "我" in "我愛你/我愛迩", or loanwords) represents "うぉ".
	if (ruby.includes("を")) {
		return ruby.replace(/を/g, "うぉ");
	}

	return ruby;
}

function normalizeRubySegments(segments: RubySegment[]): RubySegment[] {
	return segments.map((seg) => {
		if (!seg.ruby) return seg;
		const normRuby = normalizeOrthographicRuby(seg.text, seg.ruby);
		return normRuby !== seg.ruby ? { ...seg, ruby: normRuby } : seg;
	});
}

function isLineAlignmentValid(segments: RubySegment[]): boolean {
	if (!segments || segments.length === 0) return true;

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (!seg.ruby) continue;

		if (!isPlausibleRuby(seg.text, seg.ruby)) {
			return false;
		}

		// Orphan mora bleed-over check:
		// If immediately preceded by unannotated kana/text (e.g. "い", "の", "を"),
		// check if the kanji's ruby starts with double identical vowels (e.g. "いいしょう" after "い")
		// or starts with the preceding kana and exceeds normal kanji mora bounds.
		if (i > 0) {
			const prevSeg = segments[i - 1];
			if (prevSeg.text && !prevSeg.ruby) {
				const lastKana = prevSeg.text.trim().slice(-1);
				if (/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(lastKana)) {
					const hLast = katakanaToHiragana(lastKana);
					if (seg.ruby.startsWith(hLast + hLast)) {
						return false;
					}
					const kanjiCount = countKanji(seg.text);
					if (seg.ruby.startsWith(hLast) && seg.ruby.length > kanjiCount * 2 + 1) {
						return false;
					}
				}
			}
		}
	}

	return true;
}

// In Japanese phonology, neither っ nor ん can begin a kanji reading; they are codas that bind to the preceding mora.
const O_OR_U_ROW = new Set([
	"お",
	"こ",
	"ご",
	"そ",
	"ぞ",
	"と",
	"ど",
	"の",
	"ほ",
	"ぼ",
	"ぽ",
	"も",
	"よ",
	"ろ",
	"を",
	"ょ",
	"う",
	"ゔ",
	"く",
	"ぐ",
	"す",
	"ず",
	"つ",
	"づ",
	"ぬ",
	"ふ",
	"ぶ",
	"ぷ",
	"む",
	"ゆ",
	"る",
	"ゅ",
]);
const E_ROW = new Set(["え", "け", "げ", "せ", "ぜ", "て", "で", "ね", "へ", "べ", "ぺ", "め", "れ", "ぇ"]);

function splitKanjiCompoundBySyllables(kanjiText: string, readingHiragana: string): string[] | null {
	if (!kanjiText || !readingHiragana) return null;
	const chars = Array.from(kanjiText);
	const kanjiCount = countKanji(kanjiText);
	if (kanjiCount < 2 || kanjiCount !== chars.length) return null;

	// Explicit dictionary mappings take precedence (supporting NFKC-normalized lookups for Kangxi Radicals)
	const normKey = kanjiText.normalize("NFKC");
	const dictMapping = COMPOUND_KANJI_MAPPINGS[kanjiText] || COMPOUND_KANJI_MAPPINGS[normKey];
	if (dictMapping) {
		return dictMapping.join("") === readingHiragana ? dictMapping : null;
	}

	// Preserve Jukujikun and iteration marks (々) as single compound units
	if (kanjiText.includes("々") || JUKUJIKUN_WORDS.has(kanjiText)) {
		return null;
	}

	const syllables: string[] = [];
	const readingChars = Array.from(katakanaToHiragana(readingHiragana));
	for (const ch of readingChars) {
		if (/^[んっーぁぃぅぇぉゃゅょゎァィゥェォャュョヮ]/u.test(ch) && syllables.length > 0) {
			syllables[syllables.length - 1] += ch;
		} else {
			syllables.push(ch);
		}
	}

	if (syllables.length === kanjiCount) {
		const allPlausible = syllables.every((syl, idx) => isPlausibleRuby(chars[idx], syl));
		if (allPlausible) {
			return syllables;
		}
	}

	if (syllables.length > kanjiCount) {
		const mergedSyllables: string[] = [];
		const hasMergedLongVowel: boolean[] = [];

		for (let idx = 0; idx < syllables.length; idx++) {
			const syl = syllables[idx];
			const currentCount = mergedSyllables.length + (syllables.length - idx);

			if (mergedSyllables.length > 0 && currentCount > kanjiCount) {
				const lastIdx = mergedSyllables.length - 1;
				const prev = mergedSyllables[lastIdx];
				const prevLast = prev[prev.length - 1];

				if (
					!hasMergedLongVowel[lastIdx] &&
					((syl === "う" && O_OR_U_ROW.has(prevLast)) || (syl === "い" && E_ROW.has(prevLast)))
				) {
					mergedSyllables[lastIdx] += syl;
					hasMergedLongVowel[lastIdx] = true;
					continue;
				}
			}

			mergedSyllables.push(syl);
			hasMergedLongVowel.push(false);
		}

		if (mergedSyllables.length === kanjiCount) {
			const allPlausible = mergedSyllables.every((syl, idx) => isPlausibleRuby(chars[idx], syl));
			if (allPlausible) {
				return mergedSyllables;
			}
		}
	}

	return null;
}

function refineCompoundKanjiParts(parts: LyricPart[], resultMap: Record<number, RubySegment[]>): void {
	for (let i = 0; i < parts.length; i++) {
		for (const [compound, readings] of Object.entries(COMPOUND_KANJI_MAPPINGS)) {
			const compLen = compound.length;
			if (readings.length !== compLen || i + compLen > parts.length) continue;

			let matches = true;
			let combinedRuby = "";
			for (let k = 0; k < compLen; k++) {
				if (parts[i + k].words.normalize("NFKC") !== compound[k].normalize("NFKC")) {
					matches = false;
					break;
				}
				const segs = resultMap[i + k];
				const ruby = segs?.map((s) => s.ruby ?? "").join("") ?? "";
				combinedRuby += ruby;
			}

			if (matches && combinedRuby === readings.join("")) {
				for (let k = 0; k < compLen; k++) {
					resultMap[i + k] = [{ text: parts[i + k].words, ruby: readings[k] }];
				}
			}
		}

		if (i + 1 < parts.length) {
			const w0 = parts[i].words;
			const w1 = parts[i + 1].words;
			if (w0.length === 1 && w1.length === 1 && containsKanji(w0) && containsKanji(w1)) {
				const compound = w0 + w1;
				const segs0 = resultMap[i];
				const segs1 = resultMap[i + 1];
				const r0 = segs0?.map((s) => s.ruby ?? "").join("") ?? "";
				const r1 = segs1?.map((s) => s.ruby ?? "").join("") ?? "";
				const candidateReading = r0 === r1 ? r0 : r0 + r1;
				if (candidateReading) {
					const split = splitKanjiCompoundBySyllables(compound, candidateReading);
					if (split && split.length === 2) {
						resultMap[i] = [{ text: w0, ruby: split[0] }];
						resultMap[i + 1] = [{ text: w1, ruby: split[1] }];
					}
				}
			}
		}
	}
}

// Guards against phonetic bleed-over based on kanji/numeric mora bounds
export function isPlausibleRuby(text: string, ruby: string, hasOkurigana = false): boolean {
	if (!text || !ruby) return false;
	const chars = Array.from(text);
	const kanjiCount = countKanji(text);
	if (kanjiCount === 0) return true;

	const rubyKana = katakanaToHiragana(ruby.replace(/[^\p{Script=Hiragana}\p{Script=Katakana}\u30FC]/gu, ""));
	if (rubyKana.length === 0) return false;

	// Japanese Kanji readings never start with ん/っ or small kana (拗音/促音/撥音 cannot start a word)
	if (/^[んっぁぃぅぇぉゃゅょゎ]/u.test(rubyKana)) return false;

	const numDigits = (text.match(/[0-9０-９]/g) || []).length;
	const digitSequences = (text.match(/[0-9０-９]+/g) || []).length;
	const minMora = kanjiCount + digitSequences;

	if (rubyKana.length < minMora) return false;

	const otherNonKanjiLen = chars.length - kanjiCount - numDigits;
	// Single kanji nouns can have up to 4 moras (e.g. 魂->たましい), but with okurigana stems rarely exceed 3
	const singleMax = text === "志" ? 5 : hasOkurigana && text !== "承" && text !== "慈" ? 3 : 4;
	const kanjiMax = kanjiCount === 1 ? singleMax : kanjiCount * 3;
	const maxMora = kanjiMax + numDigits * 4 + otherNonKanjiLen * 2;
	return rubyKana.length <= maxMora;
}

function buildLineReading(lineText: string, rawFullReading: string): string {
	if (!rawFullReading) return "";

	const latinSegments: { text: string; start: number; end: number }[] = [];
	const regex = /\b[A-Za-z0-9'’\-]+(?:\s+[A-Za-z0-9'’\-]+)*\b/g;

	for (const m of lineText.matchAll(regex)) {
		if (/[A-Za-z]/.test(m[0])) {
			latinSegments.push({ text: m[0], start: m.index, end: m.index + m[0].length });
		}
	}

	// Pre-normalize English loanwords in reading that correspond to Katakana words in lineText
	const katakanaWords = (lineText.match(/[\p{Script=Katakana}\u30FC]+/gu) || []).map((k) => katakanaToHiragana(k));
	const effectiveReading = rawFullReading.replace(/\b[a-zA-Z]+(?:'[a-zA-Z]+)?\b/g, (match) => {
		if (latinSegments.some((seg) => seg.text.toLowerCase() === match.toLowerCase())) {
			return match;
		}
		const lower = match.toLowerCase();
		const loanReading = COMMON_ENGLISH_LOANWORDS[lower];
		if (loanReading && (katakanaWords.includes(loanReading) || !isStrictRomajiWord(lower))) {
			return loanReading;
		}
		return match;
	});

	if (latinSegments.length === 0) {
		return romajiToHiragana(effectiveReading, true);
	}

	const lowerReading = effectiveReading.toLowerCase();
	const foundPositions: { text: string; start: number; end: number }[] = [];
	let searchStart = 0;
	for (const seg of latinSegments) {
		const idx = lowerReading.indexOf(seg.text.toLowerCase(), searchStart);
		if (idx !== -1) {
			foundPositions.push({
				text: effectiveReading.slice(idx, idx + seg.text.length),
				start: idx,
				end: idx + seg.text.length,
			});
			searchStart = idx + seg.text.length;
		}
	}

	if (foundPositions.length === 0) {
		return romajiToHiragana(effectiveReading, true);
	}

	let result = "";
	let cursor = 0;
	for (const pos of foundPositions) {
		if (pos.start > cursor) {
			const romajiPart = effectiveReading.slice(cursor, pos.start);
			if (!result.endsWith(" ") && romajiPart.startsWith(" ")) result += " ";
			result += romajiToHiragana(romajiPart, true);
			if (!result.endsWith(" ") && romajiPart.endsWith(" ")) result += " ";
		}
		if (!result.endsWith(" ") && pos.start > 0 && effectiveReading[pos.start - 1] === " " && result.length > 0) {
			result += " ";
		}
		result += pos.text;
		cursor = pos.end;
	}
	if (cursor < effectiveReading.length) {
		const romajiPart = effectiveReading.slice(cursor);
		if (!result.endsWith(" ") && (romajiPart.startsWith(" ") || result.length > 0)) result += " ";
		result += romajiToHiragana(romajiPart, true);
	}

	return result;
}

/**
 * Tiered alignment approach:
 * 1. Line-level kana anchor baseline for global alignment.
 * 2. Monotonic consumption cursor for timed syllable parts.
 * 3. Mora ratio guard to prevent phonetic bleed-over.
 */
export function alignLineParts(
	parts: LyricPart[],
	timedRomanization?: LyricPart[] | null,
	fullLineRomanization?: string | null,
	fullLineText?: string | null,
): Record<number, RubySegment[]> {
	const result: Record<number, RubySegment[]> = {};
	if (!parts || parts.length === 0) return result;

	const fullText = fullLineText || parts.map((p) => p.words).join("");
	const normFull = fullText ? normalizePunctuation(fullText) : "";
	const cleanTimedRom = timedRomanization ? timedRomanization.filter((r) => r.words && r.words.trim().length > 0) : [];

	const rawFullReading =
		fullLineRomanization || (cleanTimedRom.length > 0 ? cleanTimedRom.map((r) => r.words).join(" ") : null);
	const globalReadingHiragana = rawFullReading ? buildLineReading(fullText, rawFullReading) : null;
	const globalSegments =
		globalReadingHiragana && containsKanji(fullText) ? alignLineByKanaAnchors(fullText, globalReadingHiragana) : null;

	const getGlobalFallbackForPart = (partStartChar: number, partEndChar: number, partWords: string): RubySegment[] => {
		if (!globalSegments || !containsKanji(partWords)) {
			return [{ text: partWords }];
		}

		const matchedSegs: RubySegment[] = [];
		let segStart = 0;

		for (const seg of globalSegments) {
			const segLen = seg.text.length;
			const segEnd = segStart + segLen;

			const overlapStart = Math.max(partStartChar, segStart);
			const overlapEnd = Math.min(partEndChar, segEnd);

			if (overlapStart < overlapEnd) {
				if (overlapStart === segStart && overlapEnd === segEnd) {
					if (!seg.ruby || isPlausibleRuby(seg.text, seg.ruby)) {
						matchedSegs.push(seg);
					} else {
						matchedSegs.push({ text: seg.text });
					}
				} else {
					const localStart = overlapStart - segStart;
					const localEnd = overlapEnd - segStart;
					const slicedText = seg.text.slice(localStart, localEnd);

					if (seg.ruby) {
						const splitReadings = splitKanjiCompoundBySyllables(seg.text, seg.ruby);
						if (splitReadings && splitReadings.length === seg.text.length) {
							const slicedRuby = splitReadings.slice(localStart, localEnd).join("");
							if (isPlausibleRuby(slicedText, slicedRuby)) {
								matchedSegs.push({ text: slicedText, ruby: slicedRuby });
							} else {
								matchedSegs.push({ text: slicedText });
							}
						} else if (slicedText === seg.text) {
							if (isPlausibleRuby(slicedText, seg.ruby)) {
								matchedSegs.push({ text: slicedText, ruby: seg.ruby });
							} else {
								matchedSegs.push({ text: slicedText });
							}
						} else {
							matchedSegs.push({ text: slicedText });
						}
					} else {
						matchedSegs.push({ text: slicedText });
					}
				}
			}

			segStart = segEnd;
		}

		if (matchedSegs.length > 0) {
			const combinedSegText = matchedSegs.map((s) => s.text).join("");
			if (combinedSegText !== partWords && normalizePunctuation(combinedSegText) === normalizePunctuation(partWords)) {
				let cursor = 0;
				for (const seg of matchedSegs) {
					const segLen = seg.text.length;
					seg.text = partWords.slice(cursor, cursor + segLen);
					cursor += segLen;
				}
			}
			return matchedSegs;
		}
		return [{ text: partWords }];
	};

	if (cleanTimedRom.length > 0) {
		// Automatically compensate for global timing offsets (e.g. iTunes metadata leadingSilence offset)
		let alignedTimedRom = cleanTimedRom;
		if (parts.length > 0 && cleanTimedRom.length > 0) {
			const firstVocalPart = parts.find((p) =>
				/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]/u.test(p.words),
			);
			const firstVocalRom = cleanTimedRom.find((r) =>
				/[\p{Script=Hiragana}\p{Script=Katakana}\p{Letter}\p{Number}]/u.test(r.words),
			);
			if (firstVocalPart && firstVocalRom) {
				const offset = firstVocalRom.startTimeMs - firstVocalPart.startTimeMs;
				if (Math.abs(offset) > 25 && Math.abs(offset) < 5000) {
					alignedTimedRom = cleanTimedRom.map((r) => ({
						...r,
						startTimeMs: r.startTimeMs - offset,
					}));
				}
			}
		}

		let romCursor = 0;
		let searchIdx = 0;
		const timedSegsByPart: Record<number, RubySegment[]> = {};

		parts.forEach((part, partIdx) => {
			let partStartChar = searchIdx;
			let partEndChar = searchIdx + part.words.length;
			let partFoundInFullText = false;
			if (fullText) {
				let foundIdx = fullText.indexOf(part.words, searchIdx);
				const matchLen = part.words.length;
				if (foundIdx === -1 && normFull) {
					const normPart = normalizePunctuation(part.words);
					const normIdx = normFull.indexOf(normPart, searchIdx);
					if (normIdx !== -1) {
						foundIdx = normIdx;
					}
				}
				if (foundIdx !== -1) {
					partFoundInFullText = true;
					partStartChar = foundIdx;
					partEndChar = foundIdx + matchLen;
					searchIdx = partEndChar;
				} else {
					searchIdx += part.words.length;
				}
			}

			const partStart = part.startTimeMs;
			const partDuration = Math.max(part.durationMs, 1);
			const partEnd = partStart + partDuration;

			const matchingRoms: LyricPart[] = [];
			let nextCursor = romCursor;

			for (let rIdx = romCursor; rIdx < alignedTimedRom.length; rIdx++) {
				const r = alignedTimedRom[rIdx];
				const rStart = r.startTimeMs;
				const rDuration = Math.max(r.durationMs, 1);
				const rEnd = rStart + rDuration;

				const overlapStart = Math.max(partStart, rStart);
				const overlapEnd = Math.min(partEnd, rEnd);
				const overlap = overlapEnd - overlapStart;

				const rMid = rStart + rDuration / 2;
				const isMidpointInside = rMid >= partStart && rMid <= partEnd;
				const isSignificantOverlap = overlap >= 20 && (overlap / rDuration >= 0.35 || overlap / partDuration >= 0.35);

				if (isMidpointInside || isSignificantOverlap) {
					matchingRoms.push(r);
					nextCursor = rIdx + 1;
				} else if (matchingRoms.length > 0) {
					if (rStart >= partEnd) {
						break;
					}
				}
			}

			// Non-kanji parts (like kana, particles "nee", "o", "ga") consume their rom token so it's not grabbed by subsequent kanji
			if (matchingRoms.length > 0) {
				romCursor = nextCursor;
			}

			if (!containsKanji(part.words)) {
				result[partIdx] = [{ text: part.words }];
				return;
			}

			let timedSegs: RubySegment[] | null = null;
			if (matchingRoms.length > 0) {
				const combinedRomText = matchingRoms.map((r) => r.words).join("");
				const segs = alignWordWithReading(part.words, combinedRomText);
				const isPlausible = segs.every((s) => !s.ruby || isPlausibleRuby(s.text, s.ruby));
				if (isPlausible) {
					timedSegs = segs;
					timedSegsByPart[partIdx] = segs;
				}
			}

			// Prioritize line-level segmentation (globalSegments) which preserves full grammatical & okurigana context
			let candidateSegs: RubySegment[] | null = null;
			if (partFoundInFullText) {
				const globalSegs = getGlobalFallbackForPart(partStartChar, partEndChar, part.words);
				if (globalSegs.some((s) => Boolean(s.ruby))) {
					candidateSegs = globalSegs;
				}
			}

			if (!candidateSegs && timedSegs) {
				candidateSegs = timedSegs;
			}

			result[partIdx] = candidateSegs || [{ text: part.words }];
		});

		refineCompoundKanjiParts(parts, result);
		for (const [k, segs] of Object.entries(result)) {
			result[Number(k)] = normalizeRubySegments(segs);
		}
		const allSegs: RubySegment[] = [];
		parts.forEach((p, idx) => {
			allSegs.push(...(result[idx] || [{ text: p.words }]));
		});
		if (!isLineAlignmentValid(allSegs)) {
			const fallbackResult: Record<number, RubySegment[]> = {};
			parts.forEach((p, idx) => {
				fallbackResult[idx] = timedSegsByPart[idx] ? [...timedSegsByPart[idx]] : [{ text: p.words }];
			});
			refineCompoundKanjiParts(parts, fallbackResult);
			for (const [k, segs] of Object.entries(fallbackResult)) {
				fallbackResult[Number(k)] = normalizeRubySegments(segs);
			}
			const fallbackAllSegs: RubySegment[] = [];
			parts.forEach((p, idx) => {
				fallbackAllSegs.push(...(fallbackResult[idx] || [{ text: p.words }]));
			});
			if (isLineAlignmentValid(fallbackAllSegs)) {
				parts.forEach((p, idx) => {
					result[idx] = fallbackResult[idx];
				});
			} else {
				parts.forEach((p, idx) => {
					result[idx] = [{ text: p.words }];
				});
			}
		}
		return result;
	}

	if (globalSegments) {
		let searchIdx = 0;
		parts.forEach((part, partIdx) => {
			let partStartChar = searchIdx;
			let partEndChar = searchIdx + part.words.length;
			let partFoundInFullText = false;
			if (fullText) {
				let foundIdx = fullText.indexOf(part.words, searchIdx);
				const matchLen = part.words.length;
				if (foundIdx === -1 && normFull) {
					const normPart = normalizePunctuation(part.words);
					const normIdx = normFull.indexOf(normPart, searchIdx);
					if (normIdx !== -1) {
						foundIdx = normIdx;
					}
				}
				if (foundIdx !== -1) {
					partFoundInFullText = true;
					partStartChar = foundIdx;
					partEndChar = foundIdx + matchLen;
					searchIdx = partEndChar;
				} else {
					searchIdx += part.words.length;
				}
			}

			if (!containsKanji(part.words) || !partFoundInFullText) {
				result[partIdx] = [{ text: part.words }];
				return;
			}

			const segs = getGlobalFallbackForPart(partStartChar, partEndChar, part.words);
			result[partIdx] = segs;
		});

		refineCompoundKanjiParts(parts, result);
		for (const [k, segs] of Object.entries(result)) {
			result[Number(k)] = normalizeRubySegments(segs);
		}
		const allSegs: RubySegment[] = [];
		parts.forEach((p, idx) => {
			allSegs.push(...(result[idx] || [{ text: p.words }]));
		});
		if (!isLineAlignmentValid(allSegs)) {
			parts.forEach((p, idx) => {
				result[idx] = [{ text: p.words }];
			});
		}
		return result;
	}

	parts.forEach((part, partIdx) => {
		result[partIdx] = [{ text: part.words }];
	});

	return result;
}

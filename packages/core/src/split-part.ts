import type { LyricPart } from "@braccato/parsers";

export interface SplitSubPart extends LyricPart {
	isWrapAfter: boolean;
}

const BREAK_CHAR_RE = /[\s​­\p{Dash_Punctuation}]/u;
const TRAILING_WS_RE = /\s+$/;
const SEGMENT_LENGTH_THRESHOLD = 5;

function shouldSplit(text: string): boolean {
	const core = text.replace(TRAILING_WS_RE, "");
	if (core.length <= SEGMENT_LENGTH_THRESHOLD) return false;
	return !BREAK_CHAR_RE.test(core);
}

function segment(text: string): string[] {
	try {
		const wordSeg = new Intl.Segmenter(undefined, { granularity: "word" });
		const words = Array.from(wordSeg.segment(text), (s) => s.segment);
		if (words.length > 1) return words;

		const graphSeg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
		return Array.from(graphSeg.segment(text), (s) => s.segment);
	} catch {
		return Array.from(text);
	}
}

export function splitPart(part: LyricPart): SplitSubPart[] {
	if (!shouldSplit(part.words)) {
		return [{ ...part, isWrapAfter: false }];
	}

	const segments = segment(part.words);
	if (segments.length <= 1) {
		return [{ ...part, isWrapAfter: false }];
	}

	const perDuration = part.durationMs / segments.length;
	return segments.map((seg, i) => ({
		startTimeMs: part.startTimeMs + i * perDuration,
		durationMs: perDuration,
		words: seg,
		isBackground: part.isBackground,
		isWrapAfter: i < segments.length - 1,
	}));
}

import type { LyricPart } from "@braccato/parsers";

export interface SplitSubPart extends LyricPart {
	isWrapAfter: boolean;
}

function segment(text: string): string[] {
	try {
		const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
		return Array.from(segmenter.segment(text), (s) => s.segment);
	} catch {
		return Array.from(text);
	}
}

export function splitPart(part: LyricPart): SplitSubPart[] {
	const segments = segment(part.words);
	if (segments.length === 0) {
		return [
			{
				startTimeMs: part.startTimeMs,
				durationMs: part.durationMs,
				words: part.words,
				isBackground: part.isBackground,
				isWrapAfter: false,
			},
		];
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

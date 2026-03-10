import type { Lyric, LyricParser, LyricPart } from "./types.js";

export const QRCParser: LyricParser = {
	detect(input: string): boolean {
		return /\[\d+,\d+\]/.test(input) && /\(\d+,\d+\)/.test(input);
	},
	parse(input: string, _duration = 0): Lyric[] {
		const lines = input.split("\n");
		const lyrics: Lyric[] = [];

		for (const rawLine of lines) {
			const line = rawLine.trim();
			const lineMatch = line.match(/^\[(\d+),(\d+)\](.*)$/);
			if (!lineMatch) continue;

			const startTimeMs = Number.parseInt(lineMatch[1], 10);
			const lineDurationMs = Number.parseInt(lineMatch[2], 10);
			const content = lineMatch[3];

			const parts: LyricPart[] = [];
			let fullText = "";
			const wordRegex = /([^(]*)\((\d+),(\d+)\)/g;

			for (const wordMatch of content.matchAll(wordRegex)) {
				const word = wordMatch[1];
				const wordStart = Number.parseInt(wordMatch[2], 10);
				const wordDuration = Number.parseInt(wordMatch[3], 10);
				fullText += word;
				parts.push({ startTimeMs: wordStart, words: word, durationMs: wordDuration });
			}

			lyrics.push({
				startTimeMs,
				words: fullText,
				durationMs: lineDurationMs,
				parts: parts.length > 0 ? parts : undefined,
			});
		}

		return lyrics;
	},
};

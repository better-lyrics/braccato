import type { Lyric, LyricParser, LyricPart } from "./types.js";

const POSSIBLE_ID_TAGS = ["ti", "ar", "al", "au", "lr", "length", "by", "offset", "re", "tool", "ve", "#"];

const TIME_TAG_REGEX = /\[(\d+:\d+\.\d+)\]/g;
const ENHANCED_WORD_REGEX = /<(\d+:\d+\.\d+)>/g;
const ID_TAG_REGEX = /^\[(\w+):(.*)\]$/;

function parseTime(timeStr: string | number | undefined): number {
	if (!timeStr) return 0;
	if (typeof timeStr === "number") return timeStr;

	const parts = timeStr.split(":");
	let totalMs = 0;

	try {
		if (parts.length === 1) {
			totalMs = Number.parseFloat(parts[0]) * 1000;
		} else if (parts.length === 2) {
			const minutes = Number.parseInt(parts[0], 10);
			const seconds = Number.parseFloat(parts[1]);
			totalMs = minutes * 60 * 1000 + seconds * 1000;
		} else if (parts.length === 3) {
			const hours = Number.parseInt(parts[0], 10);
			const minutes = Number.parseInt(parts[1], 10);
			const seconds = Number.parseFloat(parts[2]);
			totalMs = hours * 3600 * 1000 + minutes * 60 * 1000 + seconds * 1000;
		}
		return Math.round(totalMs);
	} catch {
		return 0;
	}
}

/**
 * Parse an LRC document, plain or enhanced, into lines with optional word level parts.
 *
 * The result is returned exactly as the document states it. `LRCParser.parse` runs `lrcFixers` over
 * it afterwards, which is right for Musixmatch word-by-word lyrics and wrong for sources whose
 * timings are already clean, so callers that know their source can stay on this function.
 */
export function parseLRC(lrcText: string, songDurationMs: number): Lyric[] {
	const lines = lrcText.split("\n");
	const result: Lyric[] = [];
	const idTags: Record<string, string> = {};

	for (const rawLine of lines) {
		const line = rawLine.trim();

		const idTagMatch = line.match(ID_TAG_REGEX);
		if (idTagMatch && POSSIBLE_ID_TAGS.includes(idTagMatch[1])) {
			idTags[idTagMatch[1]] = idTagMatch[2];
			continue;
		}

		// Tracked as the tags are read rather than spread into Math.min afterwards, which a line with
		// enough of them turns into a call with more arguments than the stack holds.
		let lineStartTime = Number.POSITIVE_INFINITY;
		let lineEndTime = Number.NEGATIVE_INFINITY;
		let timeTagCount = 0;
		for (const match of line.matchAll(TIME_TAG_REGEX)) {
			const time = parseTime(match[1]);
			if (time < lineStartTime) lineStartTime = time;
			if (time > lineEndTime) lineEndTime = time;
			timeTagCount++;
		}

		if (timeTagCount === 0) continue;

		const lyricPart = line.replace(TIME_TAG_REGEX, "").trim();

		const parts: LyricPart[] = [];
		let lastTime: number | null = null;
		let plainText = "";

		const fragments = lyricPart.split(ENHANCED_WORD_REGEX);

		// Musixmatch wraps each word with paired <ts>, separated by whitespace-only "gap" fragments;
		// canonical LRC has none.
		const isMusixmatchStyle = fragments.some(
			(f, i) => i % 2 === 0 && i > 0 && i < fragments.length - 1 && f.length > 0 && f.trim() === "",
		);

		fragments.forEach((rawFragment, index) => {
			if (index % 2 === 0) {
				let fragment = rawFragment;
				if (isMusixmatchStyle) {
					const trimmed = fragment.trim();
					fragment = trimmed === "" && fragment.length > 0 ? " " : trimmed;
				}
				plainText += fragment;
				// Every fragment but the one before the first timestamp belongs to the part that the
				// preceding timestamp opened, whatever time that timestamp states.
				if (parts.length > 0) {
					parts[parts.length - 1].words += fragment;
				}
			} else {
				const startTime = parseTime(rawFragment);
				if (lastTime !== null && parts.length > 0) {
					parts[parts.length - 1].durationMs = startTime - lastTime;
				}
				parts.push({ startTimeMs: startTime, words: "", durationMs: 0 });
				lastTime = startTime;
			}
		});

		const duration = lineEndTime - lineStartTime;

		result.push({
			startTimeMs: lineStartTime,
			words: plainText.trim(),
			durationMs: duration,
			parts: parts.length > 0 ? parts : undefined,
		});
	}

	for (let i = 0; i < result.length; i++) {
		const lyric = result[i];
		if (i + 1 < result.length) {
			const nextLyric = result[i + 1];
			if (lyric.durationMs === 0) {
				lyric.durationMs = Math.max(nextLyric.startTimeMs - lyric.startTimeMs, 0);
			}
			if (lyric.parts && lyric.parts.length > 0) {
				let latestStart = nextLyric.startTimeMs;
				for (const val of lyric.parts) {
					latestStart = Math.max(latestStart, val.startTimeMs);
				}
				const lastPart = lyric.parts[lyric.parts.length - 1];
				lastPart.durationMs = Math.max(nextLyric.startTimeMs - lastPart.startTimeMs, 0);
				lyric.durationMs = Math.max(latestStart - lyric.startTimeMs, 0);
			}
		} else {
			if (lyric.durationMs === 0) {
				lyric.durationMs = songDurationMs - lyric.startTimeMs;
			}
			if (lyric.parts && lyric.parts.length > 0) {
				const lastPart = lyric.parts[lyric.parts.length - 1];
				lastPart.durationMs = songDurationMs - lastPart.startTimeMs;
			}
		}
	}

	if (idTags.offset) {
		let offset = Number(idTags.offset);
		if (Number.isNaN(offset)) offset = 0;
		offset = offset * 1000;
		for (const lyric of result) {
			lyric.startTimeMs -= offset;
			lyric.parts?.forEach((part) => {
				part.startTimeMs -= offset;
			});
		}
	}

	return result;
}

export function lrcFixers(lyrics: Lyric[]): void {
	for (const lyric of lyrics) {
		if (lyric.parts) {
			for (let i = 1; i < lyric.parts.length; i++) {
				const thisPart = lyric.parts[i];
				const prevPart = lyric.parts[i - 1];
				if (thisPart.words === " " && prevPart.words !== " ") {
					const deltaTime = thisPart.durationMs - prevPart.durationMs;
					if (Math.abs(deltaTime) <= 15 || thisPart.durationMs <= 100) {
						const durationChange = thisPart.durationMs;
						prevPart.durationMs += durationChange;
						thisPart.durationMs -= durationChange;
						thisPart.startTimeMs += durationChange;
					}
				}
			}
		}
	}

	let shortDurationCount = 0;
	let durationCount = 0;
	for (const lyric of lyrics) {
		if (!lyric.parts || lyric.parts.length === 0) continue;
		for (let i = 0; i < lyric.parts.length - 2; i++) {
			const part = lyric.parts[i];
			if (part.words !== " ") {
				if (part.durationMs <= 100) shortDurationCount++;
				durationCount++;
			}
		}
	}

	if (durationCount > 0 && shortDurationCount / durationCount > 0.5) {
		for (let i = 0; i < lyrics.length; i++) {
			const lyric = lyrics[i];
			if (!lyric.parts || lyric.parts.length === 0) continue;

			for (let j = 0; j < lyric.parts.length; j++) {
				const part = lyric.parts[j];
				if (part.words === " ") continue;
				if (part.durationMs <= 400) {
					let nextPart: LyricPart | null = null;
					if (j + 1 < lyric.parts.length) {
						nextPart = lyric.parts[j + 1];
					} else if (i + 1 < lyrics.length && lyrics[i + 1].parts && lyrics[i + 1].parts!.length > 0) {
						nextPart = lyrics[i + 1].parts![0];
					}

					if (nextPart === null) {
						part.durationMs = 300;
					} else if (nextPart.words === " ") {
						part.durationMs += nextPart.durationMs;
						nextPart.startTimeMs += nextPart.durationMs;
						nextPart.durationMs = 0;
					} else {
						part.durationMs = nextPart.startTimeMs - part.startTimeMs;
					}
				}
			}
		}
	}
}

export const LRCParser: LyricParser = {
	detect(input: string): boolean {
		return /\[\d+:\d+\.\d+\]/.test(input);
	},
	parse(input: string, duration = 0): Lyric[] {
		const lyrics = parseLRC(input, duration);
		lrcFixers(lyrics);
		return lyrics;
	},
};

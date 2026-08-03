import type { Lyric } from "./types.js";

const DEFAULT_INSTRUMENTAL_GAP_MS = 5000;

/**
 * Turn the silences between lines into explicit instrumental lyrics, so a renderer has something to
 * show during an intro, a solo or an outro instead of holding the last sung line on screen.
 *
 * `songDurationMs` is only needed for the outro. Intro and inter-line gaps are computed from the
 * lines themselves, so passing 0 still yields those.
 */
export function insertInstrumentalBreaks(
	lyrics: Lyric[],
	songDurationMs: number,
	gapThreshold: number = DEFAULT_INSTRUMENTAL_GAP_MS,
): Lyric[] {
	if (lyrics.length === 0) return lyrics;

	const result: Lyric[] = [];

	const createInstrumental = (startTimeMs: number, durationMs: number): Lyric => ({
		startTimeMs,
		durationMs,
		words: "",
		parts: [],
		isInstrumental: true,
	});

	if (lyrics[0].startTimeMs > gapThreshold) {
		result.push(createInstrumental(0, lyrics[0].startTimeMs));
	}

	for (let i = 0; i < lyrics.length; i++) {
		result.push(lyrics[i]);

		if (i < lyrics.length - 1) {
			const currentEnd = lyrics[i].startTimeMs + lyrics[i].durationMs;
			const nextStart = lyrics[i + 1].startTimeMs;
			const gap = nextStart - currentEnd;

			if (gap > gapThreshold) {
				result.push(createInstrumental(currentEnd, gap));
			}
		}
	}

	const lastLyric = lyrics[lyrics.length - 1];
	const lastLyricEnd = lastLyric.startTimeMs + lastLyric.durationMs;
	const outroGap = songDurationMs - lastLyricEnd;

	if (outroGap > gapThreshold) {
		result.push(createInstrumental(lastLyricEnd, outroGap));
	}

	return result;
}

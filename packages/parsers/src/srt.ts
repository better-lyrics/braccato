import type { Lyric, LyricParser } from "./types.js";

function parseSRTTime(timeStr: string): number {
	const match = timeStr.trim().match(/^(\d+):(\d+):(\d+)[,.](\d+)$/);
	if (!match) return 0;
	const hours = Number.parseInt(match[1], 10);
	const minutes = Number.parseInt(match[2], 10);
	const seconds = Number.parseInt(match[3], 10);
	const ms = Number.parseInt(match[4].padEnd(3, "0").slice(0, 3), 10);
	return hours * 3600000 + minutes * 60000 + seconds * 1000 + ms;
}

export const SRTParser: LyricParser = {
	detect(input: string): boolean {
		return /\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d+ --> \d{2}:\d{2}:\d{2}[,.]\d+/.test(input);
	},
	parse(input: string, _duration = 0): Lyric[] {
		const blocks = input.trim().split(/\r?\n\r?\n/);
		const lyrics: Lyric[] = [];

		for (const block of blocks) {
			const lines = block.split(/\r?\n/);
			if (lines.length < 2) continue;

			const timeLine = lines.find((l) => l.includes("-->"));
			if (!timeLine) continue;

			const [startStr, endStr] = timeLine.split("-->").map((s) => s.trim());
			const startTimeMs = parseSRTTime(startStr);
			const endTimeMs = parseSRTTime(endStr);

			const timeLineIndex = lines.indexOf(timeLine);
			const text = lines
				.slice(timeLineIndex + 1)
				.join("\n")
				.replace(/<[^>]+>/g, "")
				.trim();

			if (text) {
				lyrics.push({
					startTimeMs,
					words: text,
					durationMs: endTimeMs - startTimeMs,
				});
			}
		}

		return lyrics;
	},
};

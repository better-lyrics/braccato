import type { Lyric, LyricParser } from "./types.js";

export const PlainParser: LyricParser = {
	detect(_input: string): boolean {
		return true;
	},
	parse(input: string, _duration = 0): Lyric[] {
		return input.split("\n").map((words) => ({
			startTimeMs: 0,
			words,
			durationMs: 0,
		}));
	},
};

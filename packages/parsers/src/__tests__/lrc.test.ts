import { describe, expect, it } from "vitest";
import { LRCParser, lrcFixers, parseLRC } from "../lrc.js";
import type { Lyric } from "../types.js";

describe("LRCParser", () => {
	describe("detect", () => {
		it("detects standard LRC format", () => {
			expect(LRCParser.detect("[00:12.50]Hello world")).toBe(true);
		});

		it("rejects non-LRC text", () => {
			expect(LRCParser.detect("Just plain text")).toBe(false);
		});

		it("rejects XML", () => {
			expect(LRCParser.detect("<tt><body></body></tt>")).toBe(false);
		});
	});

	describe("parse", () => {
		it("parses simple synced lyrics", () => {
			const lrc = `[00:12.50]Hello world
[00:15.00]Second line
[00:20.00]Third line`;

			const result = LRCParser.parse(lrc, 30000);

			expect(result).toHaveLength(3);
			expect(result[0].startTimeMs).toBe(12500);
			expect(result[0].words).toBe("Hello world");
			expect(result[1].startTimeMs).toBe(15000);
			expect(result[1].words).toBe("Second line");
		});

		it("calculates durations from next line start", () => {
			const lrc = `[00:10.00]Line one
[00:15.00]Line two
[00:25.00]Line three`;

			const result = LRCParser.parse(lrc, 30000);

			expect(result[0].durationMs).toBe(5000);
			expect(result[1].durationMs).toBe(10000);
			expect(result[2].durationMs).toBe(5000); // songDuration - startTime
		});

		it("handles enhanced LRC with word timestamps", () => {
			const lrc = "[00:10.00]<00:10.00>Hello <00:10.50>world <00:11.00>today";

			const result = LRCParser.parse(lrc, 20000);

			expect(result).toHaveLength(1);
			expect(result[0].parts).toBeDefined();
			expect(result[0].parts!.length).toBeGreaterThan(0);
			expect(result[0].words).toContain("Hello");
			expect(result[0].words).toContain("world");
		});

		it("skips ID tags", () => {
			const lrc = `[ti:Song Title]
[ar:Artist Name]
[al:Album Name]
[00:05.00]First lyric line`;

			const result = LRCParser.parse(lrc, 10000);

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("First lyric line");
		});

		it("applies offset from ID tags", () => {
			const lrc = `[offset:0.5]
[00:10.00]Line with offset`;

			const result = LRCParser.parse(lrc, 20000);

			expect(result[0].startTimeMs).toBe(10000 - 500);
		});

		it("handles empty lines between timestamps", () => {
			const lrc = `[00:05.00]Line one
[00:10.00]
[00:15.00]Line three`;

			const result = LRCParser.parse(lrc, 20000);

			expect(result).toHaveLength(3);
			expect(result[1].words).toBe("");
		});

		it("handles mm:ss.xx format", () => {
			const lrc = "[01:30.50]Ninety seconds in";
			const result = LRCParser.parse(lrc, 120000);

			expect(result[0].startTimeMs).toBe(90500);
		});

		it("returns empty array for empty input", () => {
			expect(LRCParser.parse("", 0)).toEqual([]);
		});

		it("returns empty array for input with only ID tags", () => {
			const lrc = `[ti:Title]
[ar:Artist]`;
			expect(LRCParser.parse(lrc, 0)).toEqual([]);
		});

		it("survives a line carrying more time tags than a call can take arguments", () => {
			// Reducing the tags to a start and an end by spreading them into Math.min blew the stack at
			// roughly 125,000 of them, which a dropped file reaches long before a real lyric does.
			const lrc = `${"[00:00.00]".repeat(200000)}Hello`;

			expect(() => LRCParser.parse(lrc, 10000)).not.toThrow();
			expect(LRCParser.parse(lrc, 10000)[0].words).toBe("Hello");
		});
	});

	describe("lrcFixers", () => {
		it("merges short space durations into previous word", () => {
			const lyrics: Lyric[] = [
				{
					startTimeMs: 0,
					words: "Hello world",
					durationMs: 1000,
					parts: [
						{ startTimeMs: 0, words: "Hello", durationMs: 100 },
						{ startTimeMs: 100, words: " ", durationMs: 80 },
						{ startTimeMs: 180, words: "world", durationMs: 200 },
					],
				},
			];

			lrcFixers(lyrics);

			expect(lyrics[0].parts![0].durationMs).toBe(180);
			expect(lyrics[0].parts![1].durationMs).toBe(0);
		});

		it("fudges short word durations when most are short", () => {
			const lyrics: Lyric[] = [
				{
					startTimeMs: 0,
					words: "a b c d e",
					durationMs: 5000,
					parts: [
						{ startTimeMs: 0, words: "a", durationMs: 10 },
						{ startTimeMs: 100, words: "b", durationMs: 10 },
						{ startTimeMs: 200, words: "c", durationMs: 10 },
						{ startTimeMs: 300, words: "d", durationMs: 10 },
						{ startTimeMs: 400, words: "e", durationMs: 10 },
					],
				},
			];

			lrcFixers(lyrics);

			// After fudging, durations should be recalculated
			expect(lyrics[0].parts![0].durationMs).toBeGreaterThan(10);
		});
	});

	describe("Musixmatch paired timestamps", () => {
		// Musixmatch closes every word with a second timestamp, so the whitespace between words lands
		// in its own fragment. Trimming those fragments the way canonical LRC needs would swallow the
		// space and run the words together.
		const paired = "[00:10.00]<00:10.00>Hello<00:10.40> <00:10.44>world<00:10.90> ";

		it("keeps the space between two paired words", () => {
			const result = LRCParser.parse(paired, 20000);

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Hello world");
			// The trailing part is empty because the line is trimmed before the fragments are split.
			expect(result[0].parts!.map((p) => p.words)).toEqual(["Hello", " ", "world", ""]);
		});

		it("keeps the separating spaces in canonical enhanced LRC too", () => {
			const result = LRCParser.parse("[00:10.00]<00:10.00>Hello <00:10.50>world <00:11.00>today", 20000);

			expect(result[0].words).toBe("Hello world today");
			expect(result[0].parts!.map((p) => p.words)).toEqual(["Hello ", "world ", "today"]);
		});
	});

	describe("parseLRC", () => {
		// The extension applies `lrcFixers` to Musixmatch word-by-word lyrics only, so the raw parse
		// has to be reachable on its own.
		const paired = "[00:10.00]<00:10.00>Hello<00:10.40> <00:10.44>world<00:10.90> ";

		it("returns the timings the document states, with no fixers applied", () => {
			const result = parseLRC(paired, 20000);

			expect(result[0].parts![0].durationMs).toBe(400);
			expect(result[0].parts![1].startTimeMs).toBe(10400);
			expect(result[0].parts![1].durationMs).toBe(40);
		});

		it("differs from LRCParser.parse, which runs the fixers", () => {
			const fixed = LRCParser.parse(paired, 20000);

			expect(fixed[0].parts![0].durationMs).toBe(440);
			expect(fixed[0].parts![1].startTimeMs).toBe(10440);
			expect(fixed[0].parts![1].durationMs).toBe(0);
		});

		it("applies an offset ID tag", () => {
			const result = parseLRC("[offset:0.5]\n[00:10.00]Line with offset", 20000);

			expect(result[0].startTimeMs).toBe(9500);
		});

		it("ignores an unparseable offset instead of shifting every line to NaN", () => {
			const result = parseLRC("[offset:banana]\n[00:10.00]Line", 20000);

			expect(result[0].startTimeMs).toBe(10000);
		});
	});
});

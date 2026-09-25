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

		it("keeps the words of a part that starts at zero", () => {
			// The text after a timestamp is appended to the part that timestamp opened. Testing that
			// part for truthiness instead of existence dropped the words of anything starting at 0.
			const result = LRCParser.parse("[00:00.00]<00:00.00>Hello <00:00.50>World", 5000);

			expect(result[0].words).toBe("Hello World");
			expect(result[0].parts!.map((p) => p.words)).toEqual(["Hello ", "World"]);
			expect(result[0].parts![0].startTimeMs).toBe(0);
		});

		it("never gives a negative duration when the caller omits the song duration", () => {
			// The last line and its last word end against the song duration, and the default is 0, so
			// subtracting from it used to run every one of them backwards.
			const lrc = `[00:10.00]Line one
[00:20.00]<00:20.00>Line <00:21.00>two`;

			for (const lyrics of [LRCParser.parse(lrc), parseLRC(lrc, 0)]) {
				expect(lyrics).toHaveLength(2);
				for (const line of lyrics) {
					expect(line.durationMs).toBeGreaterThanOrEqual(0);
					for (const part of line.parts ?? []) {
						expect(part.durationMs).toBeGreaterThanOrEqual(0);
					}
				}
			}
		});

		it("still ends the last line against a song duration when it is given one", () => {
			const result = LRCParser.parse("[00:10.00]Line one\n[00:20.00]Line two", 30000);

			expect(result[1].durationMs).toBe(10000);
		});

		it("survives a line carrying more time tags than a call can take arguments", () => {
			// Reducing the tags to a start and an end by spreading them into Math.min blew the stack at
			// roughly 125,000 of them, which a dropped file reaches long before a real lyric does.
			const lrc = `${"[00:00.00]".repeat(200000)}Hello`;

			expect(() => LRCParser.parse(lrc, 10000)).not.toThrow();
			expect(LRCParser.parse(lrc, 10000)[0].words).toBe("Hello");
		});
	});

	// The same contract the other parsers hold to: a file that is not this format, or is this format
	// broken, comes back empty rather than thrown.
	describe("malformed input", () => {
		const unreadable = [
			{ label: "an empty string", input: "" },
			{ label: "whitespace only", input: "   \n\t  " },
			{ label: "text that is not LRC", input: "just some prose, nothing timed about it" },
			{ label: "another lyrics format entirely", input: "<tt><body></body></tt>" },
			{ label: "deeply nested tags", input: `${"<a>".repeat(600)}x${"</a>".repeat(600)}` },
			{ label: "a time tag that is not numbers", input: "[aa:bb.cc]Hello" },
			{ label: "an empty time tag", input: "[]Hello" },
			{ label: "a time tag that stops halfway", input: "[00:10.0" },
			{ label: "ID tags with empty values", input: "[ti:]\n[ar:]" },
			{ label: "punctuation that only looks like timings", input: "::::\n...." },
		];

		it.each(unreadable)("returns nothing for $label", ({ input }) => {
			expect(() => LRCParser.parse(input, 20000)).not.toThrow();
			expect(LRCParser.parse(input, 20000)).toEqual([]);
			expect(parseLRC(input, 20000)).toEqual([]);
		});

		it("keeps an unclosed word timestamp as text rather than dropping the line", () => {
			const result = LRCParser.parse("[00:10.00]<00:10.00>Hello <00:10.50", 20000);

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Hello <00:10.50");
		});

		it("ignores an empty offset tag instead of shifting every line by NaN", () => {
			const result = LRCParser.parse("[offset:]\n[00:10.00]Hi", 20000);

			expect(result[0].startTimeMs).toBe(10000);
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

	describe("LySy background vocals", () => {
		const line =
			"[01:09.858]<01:09.858>We <01:10.182>rise <01:12.830>throne<01:13.201> [bg:<01:13.887>(Throne, <01:14.238><01:14.544>throne, <01:14.944><01:15.282>throne)<01:15.679>]";

		it("flags [bg:...] words as background and keeps the source parens", () => {
			const parts = parseLRC(line, 120000)[0].parts!;
			const lead = parts.filter((p) => !p.isBackground);
			const bg = parts.filter((p) => p.isBackground);

			expect(lead.map((p) => p.words)).toEqual(["We ", "rise ", "throne", " "]);
			expect(lead.every((p) => p.isBackground === false)).toBe(true);

			expect(bg.filter((p) => p.words.trim()).map((p) => p.words)).toEqual(["(Throne, ", "throne, ", "throne)"]);
			expect(bg.every((p) => p.isBackground === true)).toBe(true);

			for (const part of parts) {
				expect(part.words).not.toMatch(/[[\]]/);
			}
		});

		it("keeps background text and its parens in line words, without the [bg:] marker", () => {
			const parsed = parseLRC(line, 120000)[0];

			expect(parsed.words).toBe("We rise throne (Throne, throne, throne)");
			expect(parsed.words).not.toMatch(/[[\]]/);
		});

		it("carries per-word timing for the background row", () => {
			const parts = parseLRC(line, 120000)[0].parts!;
			const bg = parts.filter((p) => p.isBackground && p.words.trim());

			expect(bg.map((p) => ({ words: p.words, startTimeMs: p.startTimeMs, durationMs: p.durationMs }))).toEqual([
				{ words: "(Throne, ", startTimeMs: 73887, durationMs: 351 },
				{ words: "throne, ", startTimeMs: 74544, durationMs: 400 },
				{ words: "throne)", startTimeMs: 75282, durationMs: 397 },
			]);
		});
	});
});

describe("LRCParser.metadata", () => {
	it("reads the song author from [au:]", () => {
		expect(LRCParser.metadata("[au:Freddie Mercury]\n[00:01.00]Is this the real life")).toEqual({
			songwriters: ["Freddie Mercury"],
		});
	});

	it("reads the lyricist from [lr:]", () => {
		expect(LRCParser.metadata("[lr:方文山]\n[00:01.00]一").songwriters).toEqual(["方文山"]);
	});

	it("keeps the order the tags appear in", () => {
		expect(LRCParser.metadata("[lr:B]\n[au:A]\n[00:01.00]x").songwriters).toEqual(["B", "A"]);
	});

	describe("edge cases", () => {
		it("keeps every repeated tag rather than only the last", () => {
			expect(LRCParser.metadata("[au:A]\n[au:B]\n[00:01.00]x").songwriters).toEqual(["A", "B"]);
		});

		it("splits a tag that lists several names", () => {
			expect(LRCParser.metadata("[au: 周杰伦 / 方文山 ]\n[00:01.00]x").songwriters).toEqual(["周杰伦", "方文山"]);
		});

		it("names a person once when both tags credit them", () => {
			expect(LRCParser.metadata("[au:A]\n[lr:A]\n[00:01.00]x").songwriters).toEqual(["A"]);
		});

		it("ignores [by:], which credits the file rather than the song", () => {
			expect(LRCParser.metadata("[by:lrc maker]\n[00:01.00]x").songwriters).toEqual([]);
		});

		it("reads nothing from a document without credit tags or from empty input", () => {
			expect(LRCParser.metadata("[ti:Title]\n[ar:Artist]\n[00:01.00]x").songwriters).toEqual([]);
			expect(LRCParser.metadata("").songwriters).toEqual([]);
			expect(LRCParser.metadata("[au:]\n[00:01.00]x").songwriters).toEqual([]);
		});
	});

	describe("regressions", () => {
		it("keeps credit tags out of the parsed lines", () => {
			const result = LRCParser.parse("[au:A]\n[lr:B]\n[00:01.00]Only line", 5000);
			expect(result.map((l) => l.words)).toEqual(["Only line"]);
		});
	});
});

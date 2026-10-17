import { describe, expect, it } from "vitest";
import { LRCParser, lrcFixers, parseLRC } from "../lrc.js";
import type { Lyric } from "../types.js";

// Most of these tests are about the sung lines, so they read past the intro and breaks parseLRC adds.
const sung = (lyrics: Lyric[]) => lyrics.filter((lyric) => !lyric.isInstrumental);

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

			const result = sung(LRCParser.parse(lrc, 30000));

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

			const result = sung(LRCParser.parse(lrc, 30000));

			expect(result[0].durationMs).toBe(5000);
			expect(result[1].durationMs).toBe(10000);
			expect(result[2].durationMs).toBe(5000); // songDuration - startTime
		});

		it("handles enhanced LRC with word timestamps", () => {
			const lrc = "[00:10.00]<00:10.00>Hello <00:10.50>world <00:11.00>today";

			const result = sung(LRCParser.parse(lrc, 20000));

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

			const result = sung(LRCParser.parse(lrc, 20000));

			expect(result[0].startTimeMs).toBe(10000 - 500);
		});

		it("handles mm:ss.xx format", () => {
			const lrc = "[01:30.50]Ninety seconds in";
			const result = sung(LRCParser.parse(lrc, 120000));

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

			for (const lyrics of [sung(LRCParser.parse(lrc)), sung(parseLRC(lrc, 0))]) {
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
			const result = sung(LRCParser.parse("[00:10.00]Line one\n[00:20.00]Line two", 30000));

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

	describe("instrumental gaps", () => {
		const instrumentals = (lyrics: Lyric[]) =>
			lyrics.filter((lyric) => lyric.isInstrumental).map(({ startTimeMs, durationMs }) => [startTimeMs, durationMs]);

		describe("blank lines", () => {
			it("turns a long blank line into an instrumental line", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]\n[00:10.00]D", 20000);

				expect(result).toEqual([
					{ startTimeMs: 1000, durationMs: 3000, words: "A", parts: undefined },
					{ startTimeMs: 4000, durationMs: 6000, words: "", parts: [], isInstrumental: true },
					{ startTimeMs: 10000, durationMs: 10000, words: "D", parts: undefined },
				]);
			});

			it("drops a short blank line and ends the line before it where the blank starts", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]\n[00:06.00]B", 20000);

				expect(result.map((lyric) => [lyric.words, lyric.startTimeMs, lyric.durationMs])).toEqual([
					["A", 1000, 3000],
					["B", 6000, 14000],
				]);
			});

			it("leaves a gap exactly at the threshold alone, like the TTML gap fill", () => {
				expect(instrumentals(parseLRC("[00:01.00]A\n[00:04.00]\n[00:09.00]B", 20000))).toEqual([]);
			});

			it("merges blank lines in a row into one break", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]\n[00:08.00]\n[00:20.00]B", 30000);

				expect(instrumentals(result)).toEqual([[4000, 16000]]);
				expect(result[0].durationMs).toBe(3000);
			});

			it("turns a leading blank line into an intro", () => {
				expect(instrumentals(parseLRC("[00:00.00]\n[00:20.00]A", 30000))).toEqual([[0, 20000]]);
			});

			it("turns a trailing blank line into an outro", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]B\n[00:10.00]", 60000);

				expect(instrumentals(result)).toEqual([[10000, 50000]]);
				expect(result[1].durationMs).toBe(6000);
			});

			it("still ends the last line at a trailing blank line when no song duration is given", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]B\n[00:10.00]", 0);

				expect(result).toHaveLength(2);
				expect(result[1].durationMs).toBe(6000);
			});

			it("treats a line of only music notes as a blank line", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00] ♪ \n[00:20.00]B\n[00:24.00]♫♪\n[00:26.00]C", 30000);

				expect(instrumentals(result)).toEqual([[4000, 16000]]);
				expect(result.map((lyric) => lyric.words)).toEqual(["A", "", "B", "C"]);
			});

			it("keeps a line that has words around a music note", () => {
				expect(sung(parseLRC("[00:01.00]♪ la la ♪\n[00:04.00]B", 10000)).map((lyric) => lyric.words)).toEqual([
					"♪ la la ♪",
					"B",
				]);
			});

			it("treats an empty background group as blank but keeps a background-only line", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00][bg:]\n[00:20.00][bg:(ooh)]\n[00:22.00]B", 30000);

				expect(instrumentals(result)).toEqual([[4000, 16000]]);
				expect(sung(result).map((lyric) => lyric.words)).toEqual(["A", "(ooh)", "B"]);
			});
		});

		describe("intro and outro", () => {
			it("adds an intro when the first line starts after the threshold", () => {
				expect(instrumentals(parseLRC("[00:12.00]A\n[00:15.00]B", 20000))).toEqual([[0, 12000]]);
			});

			it("adds no intro when the first line starts within the threshold", () => {
				expect(instrumentals(parseLRC("[00:05.00]A\n[00:08.00]B", 20000))).toEqual([]);
			});

			it("runs a last line with no stated end to the song end, so there is no outro", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]B", 60000);

				expect(instrumentals(result)).toEqual([]);
				expect(result[1].durationMs).toBe(56000);
			});
		});

		describe("instrumentalGapMs", () => {
			const lrc = "[00:01.00]A\n[00:04.00]\n[00:12.00]B";

			it("defaults to the TTML threshold", () => {
				expect(instrumentals(parseLRC(lrc, 20000))).toEqual([[4000, 8000]]);
			});

			it("is respected when raised", () => {
				expect(instrumentals(parseLRC(lrc, 20000, { instrumentalGapMs: 10000 }))).toEqual([]);
			});

			it("is respected when lowered", () => {
				const result = parseLRC("[00:01.00]A\n[00:04.00]\n[00:07.00]B", 20000, { instrumentalGapMs: 2000 });

				expect(instrumentals(result)).toEqual([[4000, 3000]]);
			});
		});

		describe("enhanced LRC", () => {
			it("ends the last word and the line at a closing timestamp, with no empty part", () => {
				const [line] = parseLRC("[00:01.00]<00:01.00>Hello <00:01.50>world <00:02.00>\n[00:03.00]B", 10000);

				expect(line.durationMs).toBe(1000);
				expect(line.parts!.map((part) => [part.words, part.startTimeMs, part.durationMs])).toEqual([
					["Hello ", 1000, 500],
					["world ", 1500, 500],
				]);
			});

			it("starts a break at the closing timestamp without needing a blank line", () => {
				const result = parseLRC("[00:01.00]<00:01.00>Hello <00:02.00>\n[00:20.00]B", 30000);

				expect(instrumentals(result)).toEqual([[2000, 18000]]);
			});

			it("starts the break at the closing timestamp when a later blank line also marks it", () => {
				const result = parseLRC("[00:01.00]<00:01.00>Hello <00:02.00>\n[00:05.00]\n[00:20.00]B", 30000);

				expect(result[0].durationMs).toBe(1000);
				expect(instrumentals(result)).toEqual([[2000, 18000]]);
			});

			it("ends an unclosed last word at the blank line after it", () => {
				const [line] = parseLRC("[00:01.00]<00:01.00>Hello <00:02.00>world\n[00:05.00]\n[00:20.00]B", 30000);

				expect(line.durationMs).toBe(4000);
				expect(line.parts![1]).toMatchObject({ words: "world", durationMs: 3000 });
			});

			it("finds the breaks between Musixmatch paired lines", () => {
				const lrc = [
					"[00:01.00]<00:01.00>Hello<00:01.40> <00:01.44>world<00:01.90> ",
					"[00:02.00]<00:02.00>Again<00:02.50> ",
					"[00:20.00]<00:20.00>After<00:20.50> ",
				].join("\n");

				const result = parseLRC(lrc, 30000);

				expect(sung(result).map((lyric) => [lyric.startTimeMs, lyric.durationMs])).toEqual([
					[1000, 900],
					[2000, 500],
					[20000, 500],
				]);
				expect(instrumentals(result)).toEqual([
					[2500, 17500],
					[20500, 9500],
				]);
			});

			it("ends a line with background vocals at the later of its two closing timestamps", () => {
				const [line] = parseLRC(
					"[00:01.00]<00:01.00>Hi <00:02.00> [bg:<00:01.50>(ooh) <00:03.00>]\n[00:20.00]B",
					30000,
				);

				expect(line.durationMs).toBe(2000);
				expect(line.parts!.map((part) => part.words)).toEqual(["Hi ", "(ooh) "]);
			});

			it("adds an outro after a closed last line", () => {
				expect(instrumentals(parseLRC("[00:01.00]<00:01.00>Bye <00:02.00>", 30000))).toEqual([[2000, 28000]]);
			});
		});

		it("treats a line end tag as the end of a plain line", () => {
			const result = parseLRC("[00:01.00]Hello[00:02.00]\n[00:20.00]B", 30000);

			expect(result[0].durationMs).toBe(1000);
			expect(instrumentals(result)).toEqual([[2000, 18000]]);
		});

		it("places breaks after the offset tag is applied", () => {
			expect(instrumentals(parseLRC("[offset:1]\n[00:01.50]A\n[00:04.00]\n[00:20.00]B", 30000))).toEqual([
				[3000, 16000],
			]);
		});

		it("returns nothing for a file of only blank lines", () => {
			expect(parseLRC("[00:00.00]\n[00:10.00]", 30000)).toEqual([]);
		});

		describe("through LRCParser.parse", () => {
			it("keeps a short closed last word at its closing timestamp before a break", () => {
				const lrc = "[00:01.00]<00:01.00>a<00:01.10> <00:01.12>b<00:01.20> \n[00:20.00]<00:20.00>c<00:20.10> ";

				const [line] = LRCParser.parse(lrc, 30000);
				const last = line.parts![line.parts!.length - 1];

				expect(last.startTimeMs + last.durationMs).toBeLessThanOrEqual(line.startTimeMs + line.durationMs);
			});

			it("does not stretch a short unclosed last word across a short gap", () => {
				const lrc = "[00:01.00]<00:01.00>a <00:01.10>b <00:01.20>c\n[00:01.50]\n[00:03.00]<00:03.00>d <00:03.10>e";

				const [line] = LRCParser.parse(lrc, 10000);
				const last = line.parts![line.parts!.length - 1];

				expect(last.startTimeMs + last.durationMs).toBeLessThanOrEqual(1500);
			});
		});

		describe("regressions", () => {
			it("regression: sorts lines a file lists out of order before finding the gaps", () => {
				const result = parseLRC("[01:00.00]C\n[00:10.00]A\n[00:20.00]B", 120000);

				expect(result.map((lyric) => lyric.words)).toEqual(["", "A", "B", "C"]);
				expect(instrumentals(result)).toEqual([[0, 10000]]);
			});

			it("regression: keeps an untimed background group out of the closed lead word", () => {
				const [line] = sung(
					parseLRC("[00:10.00]<00:10.00>Hello <00:10.50>world<00:11.00> [bg:(ooh)]\n[00:30.00]Next", 60000),
				);

				expect(line.parts!.map((part) => part.words)).toEqual(["Hello ", "world", " (ooh)"]);
			});

			it("regression: keeps a short closed last word at its stated length when a break follows", () => {
				const lrc =
					"[00:10.00]<00:10.00>a <00:10.05>b <00:10.10>c<00:10.48>\n[00:20.00]<00:20.00>d <00:20.05>e <00:20.10>f<00:20.48>";

				const [line] = sung(LRCParser.parse(lrc, 30000));

				expect(line.parts![2]).toMatchObject({ words: "c", startTimeMs: 10100, durationMs: 380 });
			});
		});

		describe("invariants", () => {
			const song = [
				"[ti:Song]",
				"[00:00.00]",
				"[00:14.20]<00:14.20>First <00:14.80>line<00:15.40> ",
				"[00:16.00]<00:16.00>Second <00:16.70>line",
				"[00:18.50]",
				"[00:19.00]<00:19.00>Third<00:19.60> [bg:<00:19.20>(echo)<00:20.10>]",
				"[00:31.00]♪",
				"[00:45.00]<00:45.00>Last <00:45.60>line<00:46.30>",
				"[00:47.00]",
			].join("\n");

			for (const [label, lyrics] of [
				["parseLRC", parseLRC(song, 60000)],
				["LRCParser.parse", LRCParser.parse(song, 60000)],
			] as const) {
				it(`${label}: emits no blank sung rows`, () => {
					expect(sung(lyrics).every((lyric) => lyric.words.trim() !== "")).toBe(true);
				});

				it(`${label}: keeps lines in time order without breaks overlapping their neighbours`, () => {
					for (let i = 1; i < lyrics.length; i++) {
						expect(lyrics[i].startTimeMs).toBeGreaterThanOrEqual(lyrics[i - 1].startTimeMs);
						if (lyrics[i].isInstrumental || lyrics[i - 1].isInstrumental) {
							expect(lyrics[i].startTimeMs).toBeGreaterThanOrEqual(
								lyrics[i - 1].startTimeMs + lyrics[i - 1].durationMs,
							);
						}
					}
				});

				it(`${label}: never gives a negative duration`, () => {
					for (const lyric of lyrics) {
						expect(lyric.durationMs).toBeGreaterThanOrEqual(0);
						for (const part of lyric.parts ?? []) expect(part.durationMs).toBeGreaterThanOrEqual(0);
					}
				});

				it(`${label}: covers the song with an intro, the breaks and an outro`, () => {
					expect(instrumentals(lyrics)).toEqual([
						[0, 14200],
						[20100, 24900],
						[46300, 13700],
					]);
				});
			}
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
			const result = sung(LRCParser.parse("[00:10.00]<00:10.00>Hello <00:10.50", 20000));

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Hello <00:10.50");
		});

		it("ignores an empty offset tag instead of shifting every line by NaN", () => {
			const result = sung(LRCParser.parse("[offset:]\n[00:10.00]Hi", 20000));

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
			const result = sung(LRCParser.parse(paired, 20000));

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Hello world");
			// The closing timestamp ends "world" rather than opening an empty part of its own.
			expect(result[0].parts!.map((p) => p.words)).toEqual(["Hello", " ", "world"]);
		});

		it("keeps the separating spaces in canonical enhanced LRC too", () => {
			const result = sung(LRCParser.parse("[00:10.00]<00:10.00>Hello <00:10.50>world <00:11.00>today", 20000));

			expect(result[0].words).toBe("Hello world today");
			expect(result[0].parts!.map((p) => p.words)).toEqual(["Hello ", "world ", "today"]);
		});
	});

	describe("parseLRC", () => {
		// The extension applies `lrcFixers` to Musixmatch word-by-word lyrics only, so the raw parse
		// has to be reachable on its own.
		const paired = "[00:10.00]<00:10.00>Hello<00:10.40> <00:10.44>world<00:10.90> ";

		it("returns the timings the document states, with no fixers applied", () => {
			const result = sung(parseLRC(paired, 20000));

			expect(result[0].parts![0].durationMs).toBe(400);
			expect(result[0].parts![1].startTimeMs).toBe(10400);
			expect(result[0].parts![1].durationMs).toBe(40);
		});

		it("differs from LRCParser.parse, which runs the fixers", () => {
			const fixed = sung(LRCParser.parse(paired, 20000));

			expect(fixed[0].parts![0].durationMs).toBe(440);
			expect(fixed[0].parts![1].startTimeMs).toBe(10440);
			expect(fixed[0].parts![1].durationMs).toBe(0);
		});

		it("applies an offset ID tag", () => {
			const result = sung(parseLRC("[offset:0.5]\n[00:10.00]Line with offset", 20000));

			expect(result[0].startTimeMs).toBe(9500);
		});

		it("ignores an unparseable offset instead of shifting every line to NaN", () => {
			const result = sung(parseLRC("[offset:banana]\n[00:10.00]Line", 20000));

			expect(result[0].startTimeMs).toBe(10000);
		});
	});

	describe("LySy background vocals", () => {
		const line =
			"[01:09.858]<01:09.858>We <01:10.182>rise <01:12.830>throne<01:13.201> [bg:<01:13.887>(Throne, <01:14.238><01:14.544>throne, <01:14.944><01:15.282>throne)<01:15.679>]";

		it("flags [bg:...] words as background and keeps the source parens", () => {
			const parts = sung(parseLRC(line, 120000))[0].parts!;
			const lead = parts.filter((p) => !p.isBackground);
			const bg = parts.filter((p) => p.isBackground);

			expect(lead.map((p) => p.words)).toEqual(["We ", "rise ", "throne"]);
			expect(lead.every((p) => p.isBackground === false)).toBe(true);

			expect(bg.filter((p) => p.words.trim()).map((p) => p.words)).toEqual(["(Throne, ", "throne, ", "throne)"]);
			expect(bg.every((p) => p.isBackground === true)).toBe(true);

			for (const part of parts) {
				expect(part.words).not.toMatch(/[[\]]/);
			}
		});

		it("regression: does not stretch the lead's closed last word to where the background starts", () => {
			const throne = sung(parseLRC(line, 120000))[0].parts!.find((p) => p.words === "throne")!;

			expect(throne.durationMs).toBe(371);
		});

		it("keeps background text and its parens in line words, without the [bg:] marker", () => {
			const parsed = sung(parseLRC(line, 120000))[0];

			expect(parsed.words).toBe("We rise throne (Throne, throne, throne)");
			expect(parsed.words).not.toMatch(/[[\]]/);
		});

		it("carries per-word timing for the background row", () => {
			const parts = sung(parseLRC(line, 120000))[0].parts!;
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

	it("reads the lyricist and composer from timed credit lines", () => {
		const lrc = "[00:00.00] 作词 : 周杰伦\n[00:00.50] 作曲 : 方文山\n[00:29.36]故事的小黄花";
		expect(LRCParser.metadata(lrc).songwriters).toEqual(["周杰伦", "方文山"]);
	});

	it("reads English songwriting credit lines", () => {
		const lrc = "[00:00.00]Written by: Max Martin/Savan Kotecha\n[00:10.00]Real lyric";
		expect(LRCParser.metadata(lrc).songwriters).toEqual(["Max Martin", "Savan Kotecha"]);
	});

	it("reads a credit line split into enhanced word timings", () => {
		const lrc = "[00:00.00]<00:00.00>Lyrics <00:00.50>by: <00:01.00>Sia <00:01.50>Furler\n[00:10.00]Real lyric";
		expect(LRCParser.metadata(lrc).songwriters).toEqual(["Sia Furler"]);
	});

	it("combines the credit tags with the credit lines", () => {
		const lrc = "[au:A]\n[00:00.00]作词：A、B\n[00:10.00]Real lyric";
		expect(LRCParser.metadata(lrc).songwriters).toEqual(["A", "B"]);
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

		it("skips credit lines that are not songwriting", () => {
			const lrc = "[00:00.00]编曲：钟兴民\n[00:00.50]Produced by: Someone\n[00:01.00]混音：Mixer";
			expect(LRCParser.metadata(lrc).songwriters).toEqual([]);
		});

		it("reads Traditional Chinese songwriting credits", () => {
			expect(LRCParser.metadata("[00:00.00]作詞：周杰倫\n[00:00.50]詞：方文山").songwriters).toEqual([
				"周杰倫",
				"方文山",
			]);
		});

		it("leaves a background vocal out of the names", () => {
			expect(LRCParser.metadata("[00:00.00]作词：A [bg:(B)]").songwriters).toEqual(["A"]);
		});

		it("ignores a credit line without a time tag, which parsing drops too", () => {
			expect(LRCParser.metadata("作词：A\n[00:01.00]x").songwriters).toEqual([]);
		});

		it("does not read a singer label or a lyric with a colon as a songwriter", () => {
			expect(LRCParser.metadata("[00:01.00]Drake: yeah\n[00:02.00]Listen: I wrote this").songwriters).toEqual([]);
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

		it("keeps timed credit lines out of the parsed lines", () => {
			const lrc =
				"[00:00.00] 作词 : 周杰伦\n[00:00.50] 编曲 : 钟兴民\n[00:01.00]<00:01.00>Lyrics <00:01.50>by: <00:02.00>A\n[00:10.00]Only line";
			expect(sung(parseLRC(lrc, 20000)).map((l) => l.words)).toEqual(["Only line"]);
		});

		it("keeps a sung line whose words before the colon end in a role noun", () => {
			expect(parseLRC("[00:01.00]我听见你的声音：别走", 5000).map((l) => l.words)).toEqual(["我听见你的声音：别走"]);
		});

		it("keeps a lead line whose background vocal holds a colon", () => {
			expect(parseLRC("[00:01.00]hello [bg:(回声: yeah)]", 5000)).toHaveLength(1);
		});

		it("drops a Traditional Chinese credit block as a whole", () => {
			const lrc = "[00:00.00]作詞：周杰倫\n[00:00.50]作曲：周杰倫\n[00:01.00]編曲：鍾興民\n[00:10.00]Only line";
			expect(sung(parseLRC(lrc, 20000)).map((l) => l.words)).toEqual(["Only line"]);
		});

		it("keeps a lyric that only happens to hold a colon", () => {
			const lrc = "[00:01.00]Drake: yeah\n[00:02.00]Listen: I wrote this";
			expect(parseLRC(lrc, 5000).map((l) => l.words)).toEqual(["Drake: yeah", "Listen: I wrote this"]);
		});
	});
});

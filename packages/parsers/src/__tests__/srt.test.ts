import { describe, expect, it } from "vitest";
import { SRTParser } from "../srt.js";

describe("SRTParser", () => {
	describe("detect", () => {
		it("detects SRT format", () => {
			const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world`;
			expect(SRTParser.detect(srt)).toBe(true);
		});

		it("detects SRT with dot separator", () => {
			const srt = `1
00:00:01.000 --> 00:00:04.000
Hello`;
			expect(SRTParser.detect(srt)).toBe(true);
		});

		it("rejects non-SRT text", () => {
			expect(SRTParser.detect("[00:12.50]Hello")).toBe(false);
		});
	});

	describe("parse", () => {
		it("parses standard SRT", () => {
			const srt = `1
00:00:01,000 --> 00:00:04,000
Hello world

2
00:00:05,000 --> 00:00:08,500
Second line`;

			const result = SRTParser.parse(srt);

			expect(result).toHaveLength(2);
			expect(result[0].startTimeMs).toBe(1000);
			expect(result[0].durationMs).toBe(3000);
			expect(result[0].words).toBe("Hello world");
			expect(result[1].startTimeMs).toBe(5000);
			expect(result[1].durationMs).toBe(3500);
		});

		it("handles multi-line subtitles", () => {
			const srt = `1
00:00:01,000 --> 00:00:04,000
Line one
Line two`;

			const result = SRTParser.parse(srt);

			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Line one\nLine two");
		});

		it("strips HTML tags", () => {
			const srt = `1
00:00:01,000 --> 00:00:04,000
<i>Italic</i> and <b>bold</b>`;

			const result = SRTParser.parse(srt);
			expect(result[0].words).toBe("Italic and bold");
		});

		it("handles dot time separator", () => {
			const srt = `1
00:01:30.500 --> 00:01:35.000
Ninety seconds`;

			const result = SRTParser.parse(srt);
			expect(result[0].startTimeMs).toBe(90500);
		});

		it("handles empty input", () => {
			expect(SRTParser.parse("")).toEqual([]);
		});

		it("skips malformed blocks", () => {
			const srt = `1
not a time line
some text

2
00:00:01,000 --> 00:00:04,000
Valid line`;

			const result = SRTParser.parse(srt);
			expect(result).toHaveLength(1);
			expect(result[0].words).toBe("Valid line");
		});
	});
});

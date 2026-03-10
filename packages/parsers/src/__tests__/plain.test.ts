import { describe, expect, it } from "vitest";
import { PlainParser } from "../plain.js";

describe("PlainParser", () => {
	describe("detect", () => {
		it("always returns true", () => {
			expect(PlainParser.detect("anything")).toBe(true);
			expect(PlainParser.detect("")).toBe(true);
		});
	});

	describe("parse", () => {
		it("splits by newlines", () => {
			const result = PlainParser.parse("Line one\nLine two\nLine three");

			expect(result).toHaveLength(3);
			expect(result[0].words).toBe("Line one");
			expect(result[1].words).toBe("Line two");
			expect(result[2].words).toBe("Line three");
		});

		it("sets all times to zero", () => {
			const result = PlainParser.parse("Line one\nLine two");

			for (const lyric of result) {
				expect(lyric.startTimeMs).toBe(0);
				expect(lyric.durationMs).toBe(0);
			}
		});

		it("handles single line", () => {
			const result = PlainParser.parse("Single line");
			expect(result).toHaveLength(1);
		});
	});
});

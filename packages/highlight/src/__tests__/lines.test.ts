import { describe, expect, it } from "vitest";
import { changedRange, changedTokens, splitLines } from "../lines.js";
import { tokenize } from "../tokenize.js";
import type { Token } from "../types.js";

const texts = (lines: Token[][]) => lines.map((line) => line.map((t) => t.text).join(""));

describe("splitLines", () => {
	it("ends each line after its newline", () => {
		expect(texts(splitLines(tokenize("[00:01.00]a\n[00:02.00]b", "lrc")))).toEqual(["[00:01.00]a\n", "[00:02.00]b"]);
	});

	it("splits a token that spans several lines and keeps its type", () => {
		const lines = splitLines([{ type: "comment", text: "<!--a\nb\nc-->" }]);
		expect(lines).toEqual([
			[{ type: "comment", text: "<!--a\n" }],
			[{ type: "comment", text: "b\n" }],
			[{ type: "comment", text: "c-->" }],
		]);
	});

	describe("edge cases", () => {
		it("returns no lines for no tokens", () => {
			expect(splitLines([])).toEqual([]);
		});

		it("adds no empty line after a final newline", () => {
			expect(texts(splitLines([{ type: "text", text: "a\n" }]))).toEqual(["a\n"]);
		});

		it("keeps blank lines", () => {
			expect(texts(splitLines([{ type: "text", text: "\n\n" }]))).toEqual(["\n", "\n"]);
		});

		it("keeps CRLF together on one line", () => {
			expect(texts(splitLines([{ type: "text", text: "a\r\nb" }]))).toEqual(["a\r\n", "b"]);
		});
	});

	describe("invariants", () => {
		it("concatenates back to the input", () => {
			const src = '<tt>\n<body>\r\n<p begin="1">a\nb</p>\n\n<!--x\ny-->\n</body></tt>\n';
			expect(texts(splitLines(tokenize(src, "ttml"))).join("")).toBe(src);
		});

		it("does not mutate the tokens it splits", () => {
			const tokens: Token[] = [{ type: "text", text: "a\nb" }];
			splitLines(tokens);
			expect(tokens).toEqual([{ type: "text", text: "a\nb" }]);
		});
	});
});

describe("changedRange", () => {
	const lines = (...rows: string[]) => rows.map((text) => [{ type: "text" as const, text }]);

	it("finds a single changed line", () => {
		expect(changedRange(lines("a", "b", "c"), lines("a", "B", "c"))).toEqual({ start: 1, prevEnd: 2, nextEnd: 2 });
	});

	it("finds inserted and removed lines", () => {
		expect(changedRange(lines("a", "c"), lines("a", "b", "c"))).toEqual({ start: 1, prevEnd: 1, nextEnd: 2 });
		expect(changedRange(lines("a", "b", "c"), lines("a", "c"))).toEqual({ start: 1, prevEnd: 2, nextEnd: 1 });
	});

	it("compares types as well as text", () => {
		const prev = [[{ type: "text" as const, text: "a" }]];
		const next = [[{ type: "bgText" as const, text: "a" }]];
		expect(changedRange(prev, next)).toEqual({ start: 0, prevEnd: 1, nextEnd: 1 });
	});

	describe("edge cases", () => {
		it("reports nothing changed for equal lines", () => {
			expect(changedRange(lines("a", "b"), lines("a", "b"))).toEqual({ start: 2, prevEnd: 2, nextEnd: 2 });
		});

		it("never lets prefix and suffix overlap on repeated lines", () => {
			expect(changedRange(lines("a", "a"), lines("a", "a", "a"))).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 });
			expect(changedRange(lines("a", "a", "a"), lines("a"))).toEqual({ start: 1, prevEnd: 3, nextEnd: 1 });
		});

		it("handles empty sides", () => {
			expect(changedRange([], lines("a"))).toEqual({ start: 0, prevEnd: 0, nextEnd: 1 });
			expect(changedRange(lines("a"), [])).toEqual({ start: 0, prevEnd: 1, nextEnd: 0 });
		});

		it("splits lines at different token boundaries as different", () => {
			const prev = [
				[
					{ type: "text" as const, text: "a" },
					{ type: "text" as const, text: "b" },
				],
			];
			expect(changedRange(prev, lines("ab"))).toEqual({ start: 0, prevEnd: 1, nextEnd: 1 });
		});
	});

	describe("performance", () => {
		it("stays linear on a 1 MB document", () => {
			const src = '<p begin="00:01.000" end="00:02.000"><span begin="1" end="2">word</span></p>\n'.repeat(13_000);
			const prev = splitLines(tokenize(src, "ttml"));
			const edited = `${src.slice(0, src.length / 2)}x${src.slice(src.length / 2)}`;
			const started = performance.now();
			const range = changedRange(prev, splitLines(tokenize(edited, "ttml")));
			expect(performance.now() - started).toBeLessThan(1000);
			expect(range.nextEnd - range.start).toBe(1);
		});
	});
});

describe("changedTokens", () => {
	const tokens = (...texts: string[]) => texts.map((text) => ({ type: "text" as const, text }));

	it("finds the one token a keystroke changed", () => {
		expect(changedTokens(tokens("a", "b", "c"), tokens("a", "bx", "c"))).toEqual({ start: 1, prevEnd: 2, nextEnd: 2 });
	});

	it("finds inserted and removed tokens", () => {
		expect(changedTokens(tokens("a", "c"), tokens("a", "b", "c"))).toEqual({ start: 1, prevEnd: 1, nextEnd: 2 });
		expect(changedTokens(tokens("a", "b", "c"), tokens("a", "c"))).toEqual({ start: 1, prevEnd: 2, nextEnd: 1 });
	});

	it("compares types as well as text", () => {
		expect(changedTokens([{ type: "text", text: "a" }], [{ type: "bgText", text: "a" }])).toEqual({
			start: 0,
			prevEnd: 1,
			nextEnd: 1,
		});
	});

	describe("edge cases", () => {
		it("reports nothing changed for equal tokens", () => {
			expect(changedTokens(tokens("a", "b"), tokens("a", "b"))).toEqual({ start: 2, prevEnd: 2, nextEnd: 2 });
		});

		it("never lets prefix and suffix overlap on repeated tokens", () => {
			expect(changedTokens(tokens("a", "a"), tokens("a", "a", "a"))).toEqual({ start: 2, prevEnd: 2, nextEnd: 3 });
		});

		it("handles empty sides", () => {
			expect(changedTokens([], tokens("a"))).toEqual({ start: 0, prevEnd: 0, nextEnd: 1 });
			expect(changedTokens(tokens("a"), [])).toEqual({ start: 0, prevEnd: 1, nextEnd: 0 });
		});
	});
});

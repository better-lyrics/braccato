import { describe, expect, it } from "vitest";
import { EVERYTHING, projectLine, shiftWindow } from "../styleWindow.js";
import type { Token } from "../types.js";

const line: Token[] = [
	{ type: "punct", text: "<" },
	{ type: "tag", text: "p" },
	{ type: "punct", text: ">" },
	{ type: "text", text: "la la" },
	{ type: "punct", text: "</" },
	{ type: "tag", text: "p" },
	{ type: "punct", text: ">\n" },
];
const text = (tokens: readonly Token[]) => tokens.map((t) => t.text).join("");

describe("projectLine", () => {
	it("keeps the tokens of a line inside the window as they are", () => {
		expect(projectLine(line, 100, { from: 0, to: 1000 })).toBe(line);
		expect(projectLine(line, 100, EVERYTHING)).toBe(line);
	});

	it("renders a line outside the window as one plain text token", () => {
		expect(projectLine(line, 100, { from: 0, to: 50 })).toEqual([{ type: "text", text: text(line) }]);
		expect(projectLine(line, 100, { from: 200, to: 300 })).toEqual([{ type: "text", text: text(line) }]);
	});

	it("styles every token the window touches and merges the rest into the plain text around them", () => {
		expect(projectLine(line, 100, { from: 102, to: 104 })).toEqual([
			{ type: "text", text: "<p" },
			{ type: "punct", text: ">" },
			{ type: "text", text: "la la</p>\n" },
		]);
		expect(projectLine(line, 100, { from: 104, to: 105 })).toEqual([{ type: "text", text: "<p>la la</p>\n" }]);
	});

	describe("edge cases", () => {
		it("treats the window end as exclusive and a token ending at the window start as outside", () => {
			expect(projectLine(line, 100, { from: 101, to: 102 })).toEqual([
				{ type: "text", text: "<" },
				{ type: "tag", text: "p" },
				{ type: "text", text: ">la la</p>\n" },
			]);
		});

		it("handles an empty window and an empty line", () => {
			expect(projectLine(line, 0, { from: 5, to: 5 })).toEqual([{ type: "text", text: text(line) }]);
			expect(projectLine([], 0, { from: 0, to: 10 })).toEqual([]);
		});
	});

	describe("invariants", () => {
		it("never changes the text of the line", () => {
			for (let from = 95; from < 120; from += 3)
				for (let to = from; to < 125; to += 4) expect(text(projectLine(line, 100, { from, to }))).toBe(text(line));
		});

		it("never emits two adjacent tokens of the same type", () => {
			for (let from = 95; from < 120; from++) {
				const out = projectLine(line, 100, { from, to: from + 3 });
				for (let k = 1; k < out.length; k++) expect(out[k].type === out[k - 1].type).toBe(false);
			}
		});

		it("does not mutate the input tokens", () => {
			const copy = structuredClone(line);
			projectLine(line, 100, { from: 102, to: 104 });
			expect(line).toEqual(copy);
		});
	});
});

describe("shiftWindow", () => {
	it("moves bounds after an edit by its length change", () => {
		expect(shiftWindow({ from: 10, to: 20 }, "abcde", "abXcde")).toEqual({ from: 11, to: 21 });
	});

	it("keeps bounds before the edit", () => {
		expect(shiftWindow({ from: 1, to: 2 }, "abcdef", "abcdXef")).toEqual({ from: 1, to: 2 });
	});

	it("clamps bounds inside a deleted range to the edit", () => {
		expect(shiftWindow({ from: 3, to: 5 }, "abcdefgh", "abgh")).toEqual({ from: 2, to: 2 });
	});

	it("finds an edit deep inside a long text", () => {
		const prev = `${"ab".repeat(5000)}tail`;
		const next = `${"ab".repeat(2049)}X${"ab".repeat(2951)}tail`;
		expect(shiftWindow({ from: 4097, to: 9000 }, prev, next)).toEqual({ from: 4097, to: 9001 });
		expect(shiftWindow({ from: 4099, to: 9000 }, prev, next)).toEqual({ from: 4100, to: 9001 });
	});

	it("keeps an unbounded window unbounded", () => {
		expect(shiftWindow(EVERYTHING, "abc", "")).toEqual(EVERYTHING);
	});
});

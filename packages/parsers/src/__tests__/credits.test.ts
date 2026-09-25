import { describe, expect, it } from "vitest";
import { splitCreditNames, uniqueNames } from "../credits.js";

describe("splitCreditNames", () => {
	it("splits on slashes and commas", () => {
		expect(splitCreditNames("Max Martin / Oscar Holter, Abel Tesfaye")).toEqual([
			"Max Martin",
			"Oscar Holter",
			"Abel Tesfaye",
		]);
	});

	it("splits on the CJK list separators", () => {
		expect(splitCreditNames("周杰伦、方文山，林夕")).toEqual(["周杰伦", "方文山", "林夕"]);
	});

	describe("edge cases", () => {
		it("returns a single name untouched apart from trimming", () => {
			expect(splitCreditNames("  Freddie Mercury ")).toEqual(["Freddie Mercury"]);
		});

		it("returns nothing for empty or whitespace input", () => {
			expect(splitCreditNames("")).toEqual([]);
			expect(splitCreditNames("   ")).toEqual([]);
			expect(splitCreditNames(" / , ")).toEqual([]);
		});

		it("keeps an ampersand inside a name", () => {
			expect(splitCreditNames("Simon & Garfunkel")).toEqual(["Simon & Garfunkel"]);
		});
	});
});

describe("uniqueNames", () => {
	it("drops exact duplicates and keeps the first-seen order", () => {
		expect(uniqueNames(["B", "A", "B", "C", "A"])).toEqual(["B", "A", "C"]);
	});

	describe("edge cases", () => {
		it("trims and drops empty names", () => {
			expect(uniqueNames([" A ", "", "  ", "A"])).toEqual(["A"]);
		});

		it("returns nothing for no names", () => {
			expect(uniqueNames([])).toEqual([]);
		});

		it("treats names that differ in case as different people", () => {
			expect(uniqueNames(["Max Martin", "max martin"])).toEqual(["Max Martin", "max martin"]);
		});
	});

	describe("invariants", () => {
		it("leaves its input untouched", () => {
			const input = [" A ", "A"];
			uniqueNames(input);
			expect(input).toEqual([" A ", "A"]);
		});

		it("is idempotent", () => {
			const once = uniqueNames(["B", "A", "B"]);
			expect(uniqueNames(once)).toEqual(once);
		});
	});
});

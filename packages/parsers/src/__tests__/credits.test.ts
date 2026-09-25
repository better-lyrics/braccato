import { describe, expect, it } from "vitest";
import { isCreditLine, isCreditRole, songwritersInCreditLine, splitCreditNames, uniqueNames } from "../credits.js";

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

describe("isCreditRole", () => {
	it("recognises CJK and English roles whatever their spacing and case", () => {
		expect(isCreditRole("作词")).toBe(true);
		expect(isCreditRole(" Produced  By ")).toBe(true);
	});

	it("recognises an unlisted CJK role by the noun it ends in", () => {
		expect(isCreditRole("填词")).toBe(true);
	});

	it("does not read a singer as a role", () => {
		expect(isCreditRole("Drake")).toBe(false);
		expect(isCreditRole("王力宏")).toBe(false);
	});
});

describe("isCreditLine", () => {
	it("recognises a credit of any role", () => {
		expect(isCreditLine("编曲：钟兴民")).toBe(true);
		expect(isCreditLine(" Written by: Max Martin ")).toBe(true);
	});

	describe("edge cases", () => {
		it("rejects a lyric that only holds a colon", () => {
			expect(isCreditLine("Listen: I wrote this")).toBe(false);
		});

		it("rejects a role with no names after it", () => {
			expect(isCreditLine("作词：")).toBe(false);
		});

		it("rejects empty text", () => {
			expect(isCreditLine("")).toBe(false);
		});
	});
});

describe("songwritersInCreditLine", () => {
	it("lists the names a songwriting credit gives", () => {
		expect(songwritersInCreditLine("作曲 : 周杰伦/方文山")).toEqual(["周杰伦", "方文山"]);
		expect(songwritersInCreditLine("Lyrics by: Sia Furler")).toEqual(["Sia Furler"]);
	});

	describe("edge cases", () => {
		it("lists nothing for a credit that is not songwriting", () => {
			expect(songwritersInCreditLine("编曲：钟兴民")).toEqual([]);
			expect(songwritersInCreditLine("Produced by: Someone")).toEqual([]);
		});

		it("lists nothing for a sung line or empty text", () => {
			expect(songwritersInCreditLine("Drake: yeah")).toEqual([]);
			expect(songwritersInCreditLine("")).toEqual([]);
		});
	});
});

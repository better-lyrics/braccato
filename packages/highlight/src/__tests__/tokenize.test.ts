import { describe, expect, it } from "vitest";
import { tokenize } from "../tokenize.js";
import type { Token } from "../types.js";

const pairs = (tokens: Token[]) => tokens.map((t) => `${t.type}:${t.text}`);
const joined = (tokens: Token[]) => tokens.map((t) => t.text).join("");

describe("tokenize lrc", () => {
	it("splits line stamps, word stamps and text", () => {
		expect(pairs(tokenize("[00:01.00]<00:01.00>Hi <00:01.50>there", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:01.00",
			"punct:]",
			"punct:<",
			"wordTime:00:01.00",
			"punct:>",
			"text:Hi ",
			"punct:<",
			"wordTime:00:01.50",
			"punct:>",
			"text:there",
		]);
	});

	it("reads metadata lines", () => {
		expect(pairs(tokenize("[ti:Amazing Grace]", "lrc"))).toEqual([
			"punct:[",
			"meta:ti",
			"punct::",
			"value:Amazing Grace",
			"punct:]",
		]);
	});

	it("reads repeated line stamps", () => {
		expect(pairs(tokenize("[00:33.71][01:07.46]Twas", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:33.71",
			"punct:]",
			"punct:[",
			"timestamp:01:07.46",
			"punct:]",
			"text:Twas",
		]);
	});

	it("reads voice prefixes", () => {
		expect(pairs(tokenize("[00:27.26]v1: Was blind", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:27.26",
			"punct:]",
			"agent:v1",
			"punct::",
			"text: Was blind",
		]);
	});

	it("keeps newlines as text tokens, CRLF included", () => {
		const src = "[00:01.00]a\r\n[00:02.00]b";
		expect(joined(tokenize(src, "lrc"))).toBe(src);
		expect(pairs(tokenize(src, "lrc"))).toContain("text:\r\n");
	});
});

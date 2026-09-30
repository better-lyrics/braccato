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

describe("tokenize qrc", () => {
	it("splits line and word stamps", () => {
		expect(pairs(tokenize("[14210,4350]A(14210,300)ma(14510,280)", "qrc"))).toEqual([
			"punct:[",
			"timestamp:14210,4350",
			"punct:]",
			"text:A",
			"punct:(",
			"wordTime:14210,300",
			"punct:)",
			"text:ma",
			"punct:(",
			"wordTime:14510,280",
			"punct:)",
		]);
	});

	it("reads metadata lines", () => {
		expect(pairs(tokenize("[ar:John Newton]", "qrc"))).toEqual([
			"punct:[",
			"meta:ar",
			"punct::",
			"value:John Newton",
			"punct:]",
		]);
	});
});

describe("tokenize srt", () => {
	it("reads cue numbers, times and text", () => {
		const src = "1\n00:00:14,210 --> 00:00:18,560\nAmazing grace";
		expect(pairs(tokenize(src, "srt"))).toEqual([
			"meta:1",
			"text:\n",
			"timestamp:00:00:14,210",
			"punct: --> ",
			"timestamp:00:00:18,560",
			"text:\n",
			"text:Amazing grace",
		]);
	});

	it("handles CRLF cues", () => {
		const src = "2\r\n00:00:18,560 --> 00:00:22,910\r\nThat saved";
		expect(pairs(tokenize(src, "srt"))).toContain("timestamp:00:00:22,910");
		expect(joined(tokenize(src, "srt"))).toBe(src);
	});
});

describe("tokenize ttml", () => {
	it("splits tags, attributes and text", () => {
		expect(pairs(tokenize(`<p begin="1.5" end="2.0">Hi</p>`, "ttml"))).toEqual([
			"punct:<",
			"tag:p",
			"text: ",
			"attr:begin",
			"punct:=",
			'punct:"',
			"timestamp:1.5",
			'punct:"',
			"text: ",
			"attr:end",
			"punct:=",
			'punct:"',
			"timestamp:2.0",
			'punct:"',
			"punct:>",
			"text:Hi",
			"punct:</",
			"tag:p",
			"punct:>",
		]);
	});

	it("marks agents and roles", () => {
		const tokens = pairs(tokenize(`<tt><p ttm:agent="v1">x</p></tt>`, "ttml"));
		expect(tokens).toContain("attr:ttm:agent");
		expect(tokens).toContain("agent:v1");
	});

	it("marks background vocals as bgText", () => {
		const src = `<tt><p><span>Yeah</span> <span ttm:role="x-bg"><span>(yeah)</span></span></p></tt>`;
		const tokens = pairs(tokenize(src, "ttml"));
		expect(tokens).toContain("text:Yeah");
		expect(tokens).toContain("bgText:(yeah)");
	});

	it("marks head text as meta", () => {
		const src = "<tt><head><metadata><songwriter>Leland Wayne</songwriter></metadata></head><body/></tt>";
		expect(pairs(tokenize(src, "ttml"))).toContain("meta:Leland Wayne");
	});

	it("marks declarations and comments", () => {
		const tokens = pairs(tokenize(`<?xml version="1.0"?><!-- note --><tt></tt>`, "ttml"));
		expect(tokens[0]).toBe(`comment:<?xml version="1.0"?>`);
		expect(tokens[1]).toBe("comment:<!-- note -->");
	});
});

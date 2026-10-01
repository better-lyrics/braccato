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
			"punct:]<",
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
			"punct:][",
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
		expect(pairs(tokenize(src, "lrc"))).toContain("text:a\r\n");
	});
});

describe("tokenize merging", () => {
	it("merges punctuation that meets across stamps", () => {
		expect(pairs(tokenize("[00:01.00]<00:01.00>Hi", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:01.00",
			"punct:]<",
			"wordTime:00:01.00",
			"punct:>",
			"text:Hi",
		]);
	});

	it("merges a newline into the lyric text around it", () => {
		expect(pairs(tokenize("[00:01.00]a\n[00:02.00]b", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:01.00",
			"punct:]",
			"text:a\n",
			"punct:[",
			"timestamp:00:02.00",
			"punct:]",
			"text:b",
		]);
	});

	it("merges a leading byte order mark into the text after it", () => {
		expect(pairs(tokenize("\uFEFFno timing", "plain"))).toEqual(["text:\uFEFFno timing"]);
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
			"text:\nAmazing grace",
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
			'punct:="',
			"timestamp:1.5",
			'punct:"',
			"text: ",
			"attr:end",
			'punct:="',
			"timestamp:2.0",
			'punct:">',
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
		expect(tokens[0]).toBe(`comment:<?xml version="1.0"?><!-- note -->`);
		expect(tokens[1]).toBe("punct:<");
	});
});

describe("tokenize ttml edge cases", () => {
	it("survives an unterminated tag", () => {
		const src = `<tt><p begin="1.0`;
		expect(joined(tokenize(src, "ttml"))).toBe(src);
	});

	it("survives an unterminated comment", () => {
		expect(pairs(tokenize("<tt><!-- open", "ttml")).at(-1)).toBe("comment:<!-- open");
	});

	it("keeps unicode text intact", () => {
		expect(pairs(tokenize("<tt><p>愛は衝動 🎶</p></tt>", "ttml"))).toContain("text:愛は衝動 🎶");
	});

	it("handles single-quoted values", () => {
		expect(pairs(tokenize("<tt><p begin='1.0'>x</p></tt>", "ttml"))).toContain("timestamp:1.0");
	});
});

describe("regressions", () => {
	it("regression: attributes are not re-emitted as punctuation after the last match", () => {
		const tokens = tokenize(`<p begin="1" end="2">x</p>`, "ttml");
		const punct = tokens.filter((t) => t.type === "punct").map((t) => t.text);
		expect(punct.some((p) => p.includes("begin"))).toBe(false);
		expect(tokens.filter((t) => t.type === "attr")).toHaveLength(2);
	});

	it("regression: bgText ends when the x-bg span closes, even when nested", () => {
		const src = `<tt><p><span ttm:role="x-bg"><span>(a)</span> <span>(b)</span></span> after</p></tt>`;
		const tokens = pairs(tokenize(src, "ttml"));
		expect(tokens).toContain("bgText:(a)");
		expect(tokens).toContain("bgText:(b)");
		expect(tokens).toContain("text: after");
	});

	it("regression: self-closing tags do not leak bg depth", () => {
		const src = `<tt><p><span ttm:role="x-bg"/>after</p></tt>`;
		expect(pairs(tokenize(src, "ttml"))).toContain("text:after");
	});
});

const FIXTURES: Record<string, string> = {
	ttml: `<tt xmlns="http://www.w3.org/ns/ttml"><head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head><body dur="3:25.347"><div begin="0.443" end="17.093"><p begin="0.443" end="2.027" ttm:agent="v1"><span begin="0.443" end="0.979">Yeah,</span> <span ttm:role="x-bg"><span begin="9.550" end="10.117">(Yeah)</span></span></p></div></body></tt>`,
	lrc: "[ti:Amazing Grace]\n[ar:John Newton]\n\n[00:14.21]Amazing grace\n[00:18.56]<00:18.56>That <00:18.90>saved\n[00:27.26]v1: Was blind",
	qrc: "[ti:Amazing Grace]\n[14210,4350]A(14210,300)ma(14510,280)zing(14790,420)",
	srt: "1\n00:00:14,210 --> 00:00:18,560\nAmazing grace\n\n2\n00:00:18,560 --> 00:00:22,910\nThat saved",
	plain: "no timing\nat all",
};

describe("auto-detection", () => {
	it("detects through @braccato/parsers/format", () => {
		expect(tokenize(FIXTURES.lrc).some((t) => t.type === "timestamp")).toBe(true);
		expect(tokenize(FIXTURES.ttml).some((t) => t.type === "tag")).toBe(true);
		expect(pairs(tokenize(FIXTURES.plain))).toEqual(["text:no timing\nat all"]);
	});
});

describe("invariants", () => {
	it("concatenated tokens always equal the input", () => {
		for (const [format, src] of Object.entries(FIXTURES)) {
			expect(joined(tokenize(src)), format).toBe(src);
			expect(joined(tokenize(src.replace(/\n/g, "\r\n"))), `${format} crlf`).toBe(src.replace(/\n/g, "\r\n"));
		}
	});

	it("never emits empty tokens", () => {
		for (const src of Object.values(FIXTURES)) {
			expect(tokenize(src).every((t) => t.text.length > 0)).toBe(true);
		}
	});

	it("returns [] for empty input", () => {
		expect(tokenize("")).toEqual([]);
		expect(tokenize("", "ttml")).toEqual([]);
	});

	it("never emits two adjacent tokens of the same type", () => {
		for (const [format, src] of Object.entries(FIXTURES)) {
			const tokens = tokenize(src);
			expect(
				tokens.every((t, k) => k === 0 || tokens[k - 1].type !== t.type),
				format,
			).toBe(true);
		}
	});

	it("is deterministic", () => {
		expect(tokenize(FIXTURES.ttml)).toEqual(tokenize(FIXTURES.ttml));
	});
});

describe("regressions: text that looks like the start of a stamp", () => {
	it("regression: an lrc heart is text, not a word stamp", () => {
		const src = "[00:01.00]<3 you";
		expect(joined(tokenize(src, "lrc"))).toBe(src);
		expect(pairs(tokenize(src, "lrc"))).toContain("text:<3 you");
	});

	it("regression: an lrc heart between word stamps stays text", () => {
		const src = "<00:01.00><3 you <00:02.00>too";
		expect(joined(tokenize(src, "lrc"))).toBe(src);
		expect(pairs(tokenize(src, "lrc"))).toEqual([
			"punct:<",
			"wordTime:00:01.00",
			"punct:>",
			"text:<3 you ",
			"punct:<",
			"wordTime:00:02.00",
			"punct:>",
			"text:too",
		]);
	});

	it("regression: a qrc parenthesis with a digit is text, not a word stamp", () => {
		const src = "[1000,3000](1 more time(1000,500)";
		expect(joined(tokenize(src, "qrc"))).toBe(src);
		expect(pairs(tokenize(src, "qrc"))).toContain("text:(1 more time");
	});

	it("regression: a trailing qrc parenthesis with a digit stays text", () => {
		const src = "Hi(1000,500)(2 times";
		expect(joined(tokenize(src, "qrc"))).toBe(src);
		expect(pairs(tokenize(src, "qrc")).at(-1)).toBe("text:(2 times");
	});
});

describe("invariants: seeded random input", () => {
	const FRAGMENTS = [
		"[00:01.00]",
		"<00:01.00>",
		"<3",
		"(1000,500)",
		"(1",
		"[1000,3000]",
		'<p begin="1">',
		"</p>",
		'<span ttm:role="x-bg">',
		"</span>",
		"x-bg",
		"<tt>",
		"</tt>",
		"<head>",
		"</head>",
		"<!-- c",
		"<?xml",
		"00:00:01,000 --> 00:00:02,000",
		"[ti:x]",
		"v1:",
		"1",
		" ",
		"\n",
		"\r\n",
		"\r",
		"word",
		"日本",
		"é",
		"🎶",
		"<",
		">",
		"[",
		"]",
		"(",
		")",
		'"',
		"=",
	];

	function mulberry32(seed: number): () => number {
		let a = seed;
		return () => {
			a = (a + 0x6d2b79f5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	it("concatenated tokens equal the input for every format", () => {
		const random = mulberry32(0x5eed);
		const formats = ["ttml", "lrc", "qrc", "srt", "plain", undefined] as const;
		for (let n = 0; n < 400; n++) {
			const length = 1 + Math.floor(random() * 16);
			let src = "";
			for (let k = 0; k < length; k++) src += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)];
			for (const format of formats) {
				const tokens = tokenize(src, format);
				expect(joined(tokens), `${format ?? "auto"}: ${JSON.stringify(src)}`).toBe(src);
				expect(tokens.every((t) => t.text.length > 0)).toBe(true);
				expect(tokens.every((t, k) => k === 0 || tokens[k - 1].type !== t.type)).toBe(true);
			}
		}
	});
});

describe("line endings and namespaces", () => {
	it("treats a lone carriage return as a line ending", () => {
		const lrc = pairs(tokenize("[00:01.00]a\r[00:02.00]b", "lrc"));
		expect(lrc).toContain("text:a\r");
		expect(lrc).toContain("timestamp:00:02.00");
		const srt = pairs(tokenize("2\r00:00:18,560 --> 00:00:22,910\rThat saved", "srt"));
		expect(srt).toContain("meta:2");
		expect(srt).toContain("timestamp:00:00:22,910");
	});

	it("still keeps CRLF as one line ending", () => {
		expect(pairs(tokenize("[00:01.00]a\r\n[00:02.00]b", "lrc"))).toEqual([
			"punct:[",
			"timestamp:00:01.00",
			"punct:]",
			"text:a\r\n",
			"punct:[",
			"timestamp:00:02.00",
			"punct:]",
			"text:b",
		]);
	});

	it("marks text inside a namespaced tt:head as meta", () => {
		const src = "<tt:tt><tt:head><tt:metadata>Leland</tt:metadata></tt:head><tt:body><tt:p>x</tt:p></tt:body></tt:tt>";
		const tokens = pairs(tokenize(src, "ttml"));
		expect(tokens).toContain("meta:Leland");
		expect(tokens).toContain("text:x");
	});
});

describe("regressions: malformed input", () => {
	it("regression: a leading byte order mark does not hide the first lrc stamp", () => {
		const src = "\uFEFF[00:01.00]Hi\n[00:02.00]there";
		const tokens = pairs(tokenize(src));
		expect(tokens[0]).toBe("text:\uFEFF");
		expect(tokens[2]).toBe("timestamp:00:01.00");
		expect(joined(tokenize(src))).toBe(src);
	});
	it("regression: a stray </head> does not unbalance later head text", () => {
		const tokens = pairs(tokenize("<tt></head>lyric<head>credit</head>after</tt>", "ttml"));
		expect(tokens).toContain("text:lyric");
		expect(tokens).toContain("meta:credit");
		expect(tokens).toContain("text:after");
	});

	it("regression: a mismatched close tag does not end background vocals", () => {
		const tokens = pairs(tokenize(`<tt><p><span ttm:role="x-bg"></div>(yeah)</span> after</p></tt>`, "ttml"));
		expect(tokens).toContain("bgText:(yeah)");
		expect(tokens).toContain("text: after");
	});

	it("closing the bg span also closes unclosed children inside it", () => {
		const tokens = pairs(tokenize(`<tt><p><span ttm:role="x-bg"><br>(oh)</span> after</p></tt>`, "ttml"));
		expect(tokens).toContain("bgText:(oh)");
		expect(tokens).toContain("text: after");
	});
});

describe("performance", () => {
	it("regression: unmatched close tags stay linear", () => {
		const src = `<tt>${"<a>".repeat(50_000)}${"</b>".repeat(50_000)}</tt>`;
		const started = performance.now();
		const tokens = tokenize(src, "ttml");
		expect(performance.now() - started).toBeLessThan(1000);
		expect(joined(tokens)).toBe(src);
	});

	it("regression: many leading byte order marks do not overflow the stack", () => {
		const src = `${"\uFEFF".repeat(20_000)}[00:01.00]Hi`;
		const tokens = tokenize(src);
		expect(joined(tokens)).toBe(src);
		expect(pairs(tokens)).toContain("timestamp:00:01.00");
	});
});

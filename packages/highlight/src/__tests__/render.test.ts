import { describe, expect, it } from "vitest";
import { highlightInto } from "../render.js";
import { tokenize } from "../tokenize.js";
import type { LyricFormat } from "../types.js";
import { type FakeNode, createFakeDocument } from "./fakeDom.js";

const host = () => createFakeDocument().createElement("pre");

describe("highlightInto", () => {
	it("renders tokens as spans and text nodes", () => {
		const el = host();
		highlightInto(el as unknown as HTMLElement, "[00:01.00]Hi", { format: "lrc" });
		expect(el.children.map((c) => `${c.nodeName}.${c.className}:${c.textContent}`)).toEqual([
			"SPAN.bh-punct:[",
			"SPAN.bh-timestamp:00:01.00",
			"SPAN.bh-punct:]",
			"#text.:Hi",
		]);
	});

	it("merges adjacent tokens of the same type into one node", () => {
		const el = host();
		highlightInto(el as unknown as HTMLElement, '<p begin="1">a b</p>\n<p>', { format: "ttml" });
		expect(el.children.map((c) => `${c.nodeName}.${c.className}:${c.textContent}`)).toEqual([
			"SPAN.bh-punct:<",
			"SPAN.bh-tag:p",
			"#text.: ",
			"SPAN.bh-attr:begin",
			'SPAN.bh-punct:="',
			"SPAN.bh-timestamp:1",
			'SPAN.bh-punct:">',
			"#text.:a b",
			"SPAN.bh-punct:</",
			"SPAN.bh-tag:p",
			"SPAN.bh-punct:>",
			"#text.:\n",
			"SPAN.bh-punct:<",
			"SPAN.bh-tag:p",
			"SPAN.bh-punct:>",
		]);
	});

	it("returns the format it used and adds nothing beyond the source", () => {
		const el = host();
		expect(highlightInto(el as unknown as HTMLElement, "[00:01.00]Hi")).toBe("lrc");
		expect(el.textContent).toBe("[00:01.00]Hi");
	});

	it("pretty-breaks TTML only when asked", () => {
		const src = "<tt><body><div><p>a</p></div></body></tt>";
		const plain = host();
		const pretty = host();
		highlightInto(plain as unknown as HTMLElement, src);
		highlightInto(pretty as unknown as HTMLElement, src, { pretty: true });
		expect(plain.textContent).toBe(src);
		expect(pretty.textContent).toContain("\n    <p>");
	});

	it("ignores pretty for line formats", () => {
		const el = host();
		highlightInto(el as unknown as HTMLElement, "[00:01.00]a", { pretty: true });
		expect(el.textContent).toBe("[00:01.00]a");
	});

	it("empties the element for empty input", () => {
		const el = host();
		highlightInto(el as unknown as HTMLElement, "");
		expect(el.children).toEqual([]);
	});

	it("regression: renders a very long document without overflowing the call stack", () => {
		const el = host();
		const src = "[00:01.00]a\n".repeat(40_000);
		expect(() => highlightInto(el as unknown as HTMLElement, src, { format: "lrc" })).not.toThrow();
		expect(el.children).toHaveLength(160_000);
		expect(el.textContent).toBe(src);
	});

	it("adds the bh class to the host so token colours apply", () => {
		const el = host();
		el.className = "pane";
		highlightInto(el as unknown as HTMLElement, "[00:01.00]a");
		expect(el.className).toBe("pane bh");
		highlightInto(el as unknown as HTMLElement, "[00:02.00]b");
		expect(el.className).toBe("pane bh");
	});
});

const PARITY_SOURCES: Record<LyricFormat, string> = {
	ttml: `<tt xmlns="http://www.w3.org/ns/ttml"><head><metadata><ttm:agent type="person" xml:id="v1"/></metadata></head><body dur="3:25.347"><div><p begin="0.443" end="2.027" ttm:agent="v1"><span begin="0.443" end="0.979">Yeah,</span> <span ttm:role="x-bg"><span begin="9.550" end="10.117">(Yeah)</span></span></p></div></body></tt>`,
	lrc: "[ti:Amazing Grace]\n\n[00:14.21][00:20.00]Amazing grace\n[00:18.56]<00:18.56>That <00:18.90>saved\n[00:27.26]v1: Was blind",
	srt: "1\n00:00:14,210 --> 00:00:18,560\nAmazing grace\n\n2\n00:00:18,560 --> 00:00:22,910\nThat saved",
	qrc: "[ti:Amazing Grace]\n[14210,4350](14210,300)A(14210,300)ma(14510,280)zing(14790,420)",
	plain: "\uFEFFno timing\nat all",
};

const describeNodes = (nodes: FakeNode[]) => nodes.map((c) => `${c.nodeName}.${c.className}:${c.textContent}`);

describe("tokenize parity with highlightInto", () => {
	for (const [format, src] of Object.entries(PARITY_SOURCES) as [LyricFormat, string][]) {
		it(`draws exactly the tokenize stream for ${format}`, () => {
			const el = host();
			highlightInto(el as unknown as HTMLElement, src, { format });
			const fromTokens = tokenize(src, format).map(({ type, text }) =>
				type === "text" ? `#text.:${text}` : `SPAN.bh-${type}:${text}`,
			);
			expect(describeNodes(el.children)).toEqual(fromTokens);
		});
	}
});

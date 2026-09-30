import { describe, expect, it } from "vitest";
import { highlightInto } from "../render.js";
import { createFakeDocument } from "./fakeDom.js";

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
		expect(el.children).toHaveLength(200_000);
		expect(el.textContent).toBe(src);
	});
});

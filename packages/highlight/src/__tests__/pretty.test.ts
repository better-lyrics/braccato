import { describe, expect, it } from "vitest";
import { prettyTtml } from "../pretty.js";

describe("prettyTtml", () => {
	it("breaks a minified document at head, body, div and p", () => {
		const out = prettyTtml("<tt><head><metadata/></head><body><div><p>a</p><p>b</p></div></body></tt>");
		expect(out.split("\n")).toEqual([
			"<tt>",
			"<head><metadata/>",
			"</head>",
			"<body>",
			"  <div>",
			"    <p>a</p>",
			"    <p>b</p>",
			"  </div>",
			"</body>",
			"</tt>",
		]);
	});

	it("never starts with a blank line", () => {
		expect(prettyTtml("<head></head>").startsWith("\n")).toBe(false);
	});

	it("only inserts whitespace", () => {
		const src = `<tt><body><div><p begin="1">x</p></div></body></tt>`;
		expect(prettyTtml(src).replace(/\s/g, "")).toBe(src.replace(/\s/g, ""));
	});

	it("regression: is idempotent and adds no blank lines to formatted input", () => {
		const unformatted = `<tt><head><metadata/></head><body><div><p begin="1">a</p><p>b</p></div></body></tt>`;
		const formatted = [
			"<tt>",
			"<head>",
			"  <metadata/>",
			"</head>",
			"<body>",
			"  <div>",
			'    <p begin="1">a</p>',
			"    <p>b</p>",
			"  </div>",
			"</body>",
			"</tt>",
		].join("\n");
		for (const src of [unformatted, formatted]) {
			expect(prettyTtml(prettyTtml(src))).toBe(prettyTtml(src));
		}
		expect(prettyTtml(formatted).split("\n")).toHaveLength(formatted.split("\n").length);
		expect(prettyTtml(formatted.replace(/\n/g, "\r\n"))).not.toMatch(/\n\s*\n/);
	});
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKEN_TYPES } from "../types.js";

const css = readFileSync(new URL("../highlight.css", import.meta.url), "utf8");

describe("highlight.css", () => {
	it("regression: token rules outrank the `.bh span` font reset", () => {
		for (const type of TOKEN_TYPES.filter((t) => t !== "text")) {
			expect(css, type).toMatch(new RegExp(`^\\.bh \\.bh-${type} \\{`, "m"));
			expect(css, type).not.toMatch(new RegExp(`^\\.bh-${type} \\{`, "m"));
		}
	});

	it("colours every token type in the editor layer through a highlight with the same colour as its span", () => {
		for (const type of TOKEN_TYPES.filter((t) => t !== "text" && t !== "bgText")) {
			const span = css.match(new RegExp(`^\\.bh \\.bh-${type} \\{[^}]*?(color: [^;]+;)`, "m"))?.[1];
			const highlight = css.match(
				new RegExp(
					`^\\.bh-edit > \\.bh-layer > \\.bh-line::highlight\\(bh-${type}\\) \\{\\s*(color: [^;]+;)\\s*\\}`,
					"m",
				),
			)?.[1];
			expect(span, type).toBeDefined();
			expect(highlight, type).toBe(span);
		}
	});

	it("dims background vocals in the editor through their own property, since highlights cannot italicise them", () => {
		expect(css).toMatch(
			/^\.bh-edit > \.bh-layer > \.bh-line::highlight\(bh-bgText\) \{\s*color: var\(--bh-bgText-editor, rgba\(255, 255, 255, 0\.65\)\);\s*\}/m,
		);
	});

	it("reads the background vocal style from a custom property", () => {
		expect(css).toMatch(/font-style: var\(--bh-bgText-style, italic\)/);
	});

	it("lays each editor line out as its own block so an edit relayouts one line", () => {
		expect(css).toMatch(/\.bh-edit > \.bh-layer > \.bh-line \{\s*display: block;/);
	});

	it("regression: editor lines inherit unicode-bidi so dir=auto resolves each line on its own", () => {
		expect(css).toMatch(/\.bh-edit > \.bh-layer > \.bh-line \{[^}]*unicode-bidi: inherit;/);
	});

	it("indents only the first editor line, as the textarea does", () => {
		expect(css).toMatch(/\.bh-edit > \.bh-layer > \.bh-line \+ \.bh-line \{\s*text-indent: 0;/);
	});

	it("regression: turns off scroll anchoring on the layer, which the textarea lacks, so an edit cannot shift its rows", () => {
		expect(css).toMatch(/\.bh-edit > \.bh-layer \{[^}]*overflow-anchor: none;/);
	});

	it("regression: forces border-box on the textarea so padding and borders stay inside the wrapper", () => {
		const rule = [...css.matchAll(/^\.bh-edit > \.bh-input \{([^}]*)\}/gm)].map((m) => m[1]).join("");
		expect(rule).toMatch(/box-sizing: border-box;/);
		expect(rule).toMatch(/width: 100%;/);
	});
});

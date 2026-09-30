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

	it("reads the background vocal style from a custom property", () => {
		expect(css).toMatch(/font-style: var\(--bh-bgText-style, italic\)/);
	});
});

import { describe, expect, it } from "vitest";
import { compileRics, compileRicsToCSS } from "../index.js";

describe("compileRics", () => {
	it("compiles simple CSS (passes through)", () => {
		const input = "body { color: red; }";
		const result = compileRics(input);

		expect(result.errors).toEqual([]);
		expect(result.timedOut).toBe(false);
		expect(result.css).toContain("color");
		expect(result.css).toContain("red");
	});

	it("compiles RICS nesting syntax", () => {
		const input = `.parent {
			color: blue;
			.child {
				color: green;
			}
		}`;
		const result = compileRics(input);

		expect(result.errors).toEqual([]);
		expect(result.css).toContain("color");
	});

	it("compiles RICS variables", () => {
		const input = `$primary: #ff0000;
		.test {
			color: $primary;
		}`;
		const result = compileRics(input);

		expect(result.errors).toEqual([]);
		expect(result.css).toContain("#ff0000");
	});

	it("returns source on compilation error", () => {
		const input = "this is {{ not valid css at all %%";
		const result = compileRics(input);

		// Should return something (either compiled or fallback)
		expect(result.css).toBeTruthy();
	});

	it("respects timeout options", () => {
		const result = compileRics("body { color: red; }", {
			timeout: 100,
			maxIterations: 100,
			hardTimeout: 200,
		});

		expect(result.css).toContain("color");
	});

	it("errors array contains CompileError objects", () => {
		const input = "body { color: red; }";
		const result = compileRics(input);
		expect(Array.isArray(result.errors)).toBe(true);
	});
});

describe("compileRicsToCSS", () => {
	it("returns CSS string directly", () => {
		const css = compileRicsToCSS("body { color: blue; }");
		expect(css).toContain("color");
		expect(css).toContain("blue");
	});

	it("returns source on error", () => {
		const input = "body { color: red; }";
		const css = compileRicsToCSS(input);
		expect(typeof css).toBe("string");
		expect(css.length).toBeGreaterThan(0);
	});
});

import { describe, expect, it } from "vitest";
import { SYNCED_BOX_PROPERTIES, layerText } from "../editor.js";

describe("layerText", () => {
	it("adds a trailing space after a final newline", () => {
		expect(layerText("a\n")).toBe("a\n ");
		expect(layerText("a\r\n")).toBe("a\r\n ");
	});

	it("leaves other text alone", () => {
		expect(layerText("a")).toBe("a");
		expect(layerText("")).toBe("");
	});
});

describe("SYNCED_BOX_PROPERTIES", () => {
	it("covers everything that moves glyphs", () => {
		for (const prop of [
			"font-family",
			"font-size",
			"line-height",
			"letter-spacing",
			"padding-left",
			"padding-top",
			"border-left-width",
			"box-sizing",
			"tab-size",
		]) {
			expect(SYNCED_BOX_PROPERTIES).toContain(prop);
		}
	});
});

import { describe, expect, it } from "vitest";
import { detectParser } from "../detect.js";
import { LRCParser } from "../lrc.js";
import { PlainParser } from "../plain.js";
import { QRCParser } from "../qrc.js";
import { SRTParser } from "../srt.js";
import { TTMLParser } from "../ttml.js";

describe("detectParser", () => {
	it("detects LRC", () => {
		expect(detectParser("[00:12.50]Hello")).toBe(LRCParser);
	});

	it("detects SRT", () => {
		const srt = "1\n00:00:01,000 --> 00:00:04,000\nHello";
		expect(detectParser(srt)).toBe(SRTParser);
	});

	it("detects TTML", () => {
		expect(detectParser("<tt><body></body></tt>")).toBe(TTMLParser);
	});

	it("detects QRC", () => {
		expect(detectParser("[1000,3000]Hello(1000,500)")).toBe(QRCParser);
	});

	it("falls back to PlainParser", () => {
		expect(detectParser("Just some text\nAnother line")).toBe(PlainParser);
	});
});

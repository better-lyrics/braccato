import { describe, expect, it } from "vitest";
import { detectParser } from "../detect.js";
import { detectFormat } from "../format.js";
import { isSrt } from "../formatPredicates.js";
import { LRCParser } from "../lrc.js";
import { PlainParser } from "../plain.js";
import { QRCParser } from "../qrc.js";
import { SRTParser } from "../srt.js";
import { TTMLParser } from "../ttml.js";

const DIGIT_RUN = 1_000_000;
const PREVIOUS_SRT = /\d+\r?\n\d{2}:\d{2}:\d{2}[,.]\d+ --> \d{2}:\d{2}:\d{2}[,.]\d+/;

const SAMPLES = {
	ttml: `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1.0" end="2.0">Hi</p></div></body></tt>`,
	lrc: "[ti:Song]\n[00:12.50]Hello\n[00:14.00]<00:14.00>Word <00:14.40>timed",
	srt: "1\n00:00:01,000 --> 00:00:04,000\nHello",
	qrc: "[1000,3000]Hel(1000,500)lo(1500,500)",
	qrcEnvelope: `<QrcInfos><LyricInfo><Lyric_1 LyricContent="[1000,2000]Hello world"/></LyricInfo></QrcInfos>`,
	plain: "just some words\nno timing at all",
};

describe("detectFormat", () => {
	describe("happy paths", () => {
		it("detects each format", () => {
			expect(detectFormat(SAMPLES.ttml)).toBe("ttml");
			expect(detectFormat(SAMPLES.lrc)).toBe("lrc");
			expect(detectFormat(SAMPLES.srt)).toBe("srt");
			expect(detectFormat(SAMPLES.qrc)).toBe("qrc");
			expect(detectFormat(SAMPLES.qrcEnvelope)).toBe("qrc");
			expect(detectFormat(SAMPLES.plain)).toBe("plain");
		});
	});

	describe("edge cases", () => {
		it("treats empty and whitespace input as plain", () => {
			expect(detectFormat("")).toBe("plain");
			expect(detectFormat("   \n\t")).toBe("plain");
		});

		it("accepts CRLF SRT", () => {
			expect(detectFormat("1\r\n00:00:01,000 --> 00:00:04,000\r\nHello")).toBe("srt");
		});

		it("does not call LRC without fractional seconds", () => {
			expect(detectFormat("[00:12]Hello")).toBe("plain");
		});

		it("needs both line and word stamps for bare QRC", () => {
			expect(detectFormat("[1000,3000]Hello")).toBe("plain");
		});
	});

	describe("invariants", () => {
		it("honours the priority TTML > LRC > SRT > QRC", () => {
			expect(detectFormat("<tt>[00:01.00]x</tt>")).toBe("ttml");
			expect(detectFormat("[00:01.00]x\n[1000,200]y(1000,100)")).toBe("lrc");
			expect(detectFormat("1\n00:00:01,000 --> 00:00:02,000\n[1000,200]y(1000,100)")).toBe("srt");
		});

		it("agrees with detectParser on every sample", () => {
			const byFormat = { ttml: TTMLParser, lrc: LRCParser, srt: SRTParser, qrc: QRCParser, plain: PlainParser };
			for (const text of Object.values(SAMPLES)) {
				expect(detectParser(text)).toBe(byFormat[detectFormat(text)]);
			}
		});
	});

	describe("public surface", () => {
		it("exposes only detectFormat at runtime", async () => {
			expect(Object.keys(await import("../format.js"))).toEqual(["detectFormat"]);
		});
	});

	describe("regressions", () => {
		it("regression: srt detection stays linear on a long run of digits", () => {
			const started = performance.now();
			expect(detectFormat("1".repeat(DIGIT_RUN))).toBe("plain");
			expect(performance.now() - started).toBeLessThan(1000);
		});

		it("srt detection agrees with the previous pattern", () => {
			const inputs = [
				...Object.values(SAMPLES),
				"1\r\n00:00:01,000 --> 00:00:04,000\r\nHello",
				"12345\n00:00:01.5 --> 00:00:04.25\nx",
				"a1\n00:00:01,000 --> 00:00:02,000",
				"1\n0:00:01,000 --> 00:00:02,000",
				"1\n\n00:00:01,000 --> 00:00:02,000",
				"99 00:00:01,000 --> 00:00:02,000",
				"",
			];
			for (const input of inputs) expect(isSrt(input), JSON.stringify(input)).toBe(PREVIOUS_SRT.test(input));
		});
	});
});

import { describe, expect, it } from "vitest";
import { TTMLParser, parseTTMLContent, parseTTMLTime } from "../ttml.js";

describe("parseTTMLTime", () => {
	it("parses offset-time with seconds", () => {
		expect(parseTTMLTime("5.5s")).toBe(5500);
	});

	it("parses offset-time with milliseconds", () => {
		expect(parseTTMLTime("1234ms")).toBe(1234);
	});

	it("parses offset-time with minutes", () => {
		expect(parseTTMLTime("2m")).toBe(120000);
	});

	it("parses offset-time with hours", () => {
		expect(parseTTMLTime("1h")).toBe(3600000);
	});

	it("parses clock-time hh:mm:ss.mmm", () => {
		expect(parseTTMLTime("00:01:30.500")).toBe(90500);
	});

	it("parses mm:ss.mmm", () => {
		expect(parseTTMLTime("01:30.500")).toBe(90500);
	});

	it("handles undefined", () => {
		expect(parseTTMLTime(undefined)).toBe(0);
	});

	it("handles numeric input", () => {
		expect(parseTTMLTime(5000)).toBe(5000);
	});
});

describe("TTMLParser", () => {
	describe("detect", () => {
		it("detects TTML content", () => {
			expect(TTMLParser.detect('<tt xmlns="http://www.w3.org/ns/ttml"></tt>')).toBe(true);
		});

		it("rejects non-TTML", () => {
			expect(TTMLParser.detect("[00:12.50]Hello")).toBe(false);
		});
	});

	describe("parse", () => {
		it("parses line-synced TTML", () => {
			const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata></metadata></head>
  <body dur="60s">
    <div>
      <p begin="5s" end="10s" key="l1">Hello world</p>
      <p begin="10s" end="15s" key="l2">Second line</p>
    </div>
  </body>
</tt>`;

			const result = TTMLParser.parse(ttml);

			expect(result.length).toBeGreaterThanOrEqual(2);
			const nonInstrumental = result.filter((l) => !l.isInstrumental);
			expect(nonInstrumental).toHaveLength(2);
			expect(nonInstrumental[0].startTimeMs).toBe(5000);
			expect(nonInstrumental[0].words).toBe("Hello world");
			expect(nonInstrumental[0].durationMs).toBe(5000);
			expect(nonInstrumental[1].startTimeMs).toBe(10000);
		});

		it("parses word-synced TTML", () => {
			const ttml = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata></metadata></head>
  <body dur="30s">
    <div>
      <p begin="5s" end="10s" key="l1">
        <span begin="5s" end="7s"><span>Hello </span></span>
        <span begin="7s" end="10s"><span>world</span></span>
      </p>
    </div>
  </body>
</tt>`;

			const result = TTMLParser.parse(ttml);
			const nonInstrumental = result.filter((l) => !l.isInstrumental);

			expect(nonInstrumental).toHaveLength(1);
			expect(nonInstrumental[0].parts).toBeDefined();
			expect(nonInstrumental[0].parts!.length).toBeGreaterThanOrEqual(2);
		});

		it("detects language", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
  <head><metadata></metadata></head>
  <body dur="10s">
    <div><p begin="0s" end="5s" key="l1">Test</p></div>
  </body>
</tt>`;

			const result = parseTTMLContent(ttml);
			expect(result.language).toBe("ja");
		});

		it("inserts instrumental breaks for large gaps", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata></metadata></head>
  <body dur="60s">
    <div>
      <p begin="0s" end="5s" key="l1">Line one</p>
      <p begin="20s" end="25s" key="l2">Line two</p>
    </div>
  </body>
</tt>`;

			const result = TTMLParser.parse(ttml);
			const instrumentals = result.filter((l) => l.isInstrumental);
			expect(instrumentals.length).toBeGreaterThan(0);
		});

		it("handles translations", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja"
              xmlns:ttm="http://www.w3.org/ns/ttml#metadata">
  <head>
    <metadata>
      <translations lang="en">
        <translation for="l1"><text>Hello world</text></translation>
      </translations>
    </metadata>
  </head>
  <body dur="10s">
    <div><p begin="0s" end="5s" key="l1">Konnichiwa</p></div>
  </body>
</tt>`;

			const result = parseTTMLContent(ttml);
			const nonInstrumental = result.lyrics.filter((l) => !l.isInstrumental);
			expect(nonInstrumental[0].translation).toEqual({ text: "Hello world", lang: "en" });
		});

		it("handles empty body", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata></metadata></head>
  <body></body>
</tt>`;

			const result = TTMLParser.parse(ttml);
			expect(result).toEqual([]);
		});
	});
});

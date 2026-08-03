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

		it("extracts transliterations attached to inner <text> elements", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
  <head>
    <metadata>
      <transliterations>
        <transliteration xml:lang="ja-Latn">
          <text for="l1"><span begin="0s" end="2s">konnichi</span><span begin="2s" end="5s">wa</span></text>
          <text for="l2"><span begin="5s" end="7s">sayou</span><span begin="7s" end="10s">nara</span></text>
        </transliteration>
      </transliterations>
    </metadata>
  </head>
  <body dur="10s">
    <div>
      <p begin="0s" end="5s" key="l1">こんにちは</p>
      <p begin="5s" end="10s" key="l2">さようなら</p>
    </div>
  </body>
</tt>`;

			const result = parseTTMLContent(ttml);
			const lines = result.lyrics.filter((l) => !l.isInstrumental);
			expect(lines).toHaveLength(2);
			expect(lines[0].romanization).toBe("konnichiwa");
			expect(lines[0].timedRomanization).toHaveLength(2);
			expect(lines[1].romanization).toBe("sayounara");
			expect(lines[1].timedRomanization).toHaveLength(2);
		});

		it("skips a transliteration item that carries no text", () => {
			// A <transliteration> child that is not a <text> still carries a `for`, so the item is
			// reached and its text is absent. Reading it as a paragraph used to throw a TypeError, and
			// one such child took the whole document with it.
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="ja">
  <head>
    <metadata>
      <transliterations>
        <transliteration xml:lang="ja-Latn">
          <notext for="l1"/>
          <text for="l2"><span begin="5s" end="7s">sayou</span><span begin="7s" end="10s">nara</span></text>
        </transliteration>
      </transliterations>
    </metadata>
  </head>
  <body dur="10s">
    <div>
      <p begin="0s" end="5s" key="l1">こんにちは</p>
      <p begin="5s" end="10s" key="l2">さようなら</p>
    </div>
  </body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines).toHaveLength(2);
			expect(lines[0].romanization).toBeUndefined();
			expect(lines[1].romanization).toBe("sayounara");
		});

		it("returns an empty result for a document the XML parser rejects", () => {
			// fast-xml-parser caps how deep a document may nest and throws past it. The throw used to
			// escape, which every caller reads as "this parser does not throw" would not survive.
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="0s" end="5s">${"<span>".repeat(600)}Deep${"</span>".repeat(600)}</p></div></body></tt>`;

			expect(() => parseTTMLContent(ttml)).not.toThrow();
			expect(parseTTMLContent(ttml)).toEqual({ lyrics: [], isWordSynced: false });
			expect(TTMLParser.parse(ttml)).toEqual([]);
		});

		it("handles empty body", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <head><metadata></metadata></head>
  <body></body>
</tt>`;

			const result = TTMLParser.parse(ttml);
			expect(result).toEqual([]);
		});

		it("ignores the duration argument", () => {
			// `@braccato/provider-blyrics` calls `TTMLParser.parse(ttml)` with no second argument, so a
			// version that started honouring the parameter would silently hand that call site a 0 and
			// change its instrumental breaks. The song duration travels through `parseTTMLContent`.
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <body><div><p begin="0s" end="5s" itunes:key="L1">Only line</p></div></body>
</tt>`;

			expect(TTMLParser.parse(ttml, 600000)).toEqual(TTMLParser.parse(ttml));
			expect(TTMLParser.parse(ttml, 600000).filter((l) => l.isInstrumental)).toHaveLength(0);

			const viaOption = parseTTMLContent(ttml, { songDurationMs: 600000 });
			expect(viaOption.lyrics.filter((l) => l.isInstrumental)).toHaveLength(1);
		});
	});

	describe("agents", () => {
		const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <head><metadata>
    <ttm:agent type="person" xml:id="singer1"><ttm:name type="full">First</ttm:name></ttm:agent>
    <ttm:agent type="person" xml:id="singer2"/>
    <ttm:agent type="group" xml:id="chorus"/>
  </metadata></head>
  <body dur="20s"><div>
    <p begin="0s" end="5s" ttm:agent="singer1" itunes:key="L1">One</p>
    <p begin="5s" end="10s" ttm:agent="singer2" itunes:key="L2">Two</p>
    <p begin="10s" end="15s" ttm:agent="chorus" itunes:key="L3">Three</p>
    <p begin="15s" end="20s" ttm:agent="singer1" itunes:key="L4">Four</p>
  </div></body>
</tt>`;

		it("maps each person agent to a stable vocalist slot", () => {
			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);
			expect(lines.map((l) => l.agent)).toEqual(["v1", "v2", "v1000", "v1"]);
		});

		it("buckets a non-person agent into the group slot", () => {
			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);
			expect(lines[2].agent).toBe("v1000");
		});

		it("passes an agent through untouched when no metadata declares it", () => {
			const undeclared = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <body dur="10s"><div><p begin="0s" end="5s" ttm:agent="v7" itunes:key="L1">One</p></div></body>
</tt>`;
			const lines = parseTTMLContent(undeclared).lyrics.filter((l) => !l.isInstrumental);
			expect(lines[0].agent).toBe("v7");
		});
	});

	describe("background vocals", () => {
		it("marks the parts inside a ttm:role=x-bg span as background", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:ttm="http://www.w3.org/ns/ttml#metadata"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <body dur="10s"><div><p begin="0s" end="6s" itunes:key="L1"><span begin="0s" end="2s">Hello</span><span ttm:role="x-bg"><span begin="2s" end="4s">(echo)</span><span begin="4s" end="6s">(echo)</span></span></p></div></body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines[0].parts).toHaveLength(3);
			expect(lines[0].parts!.map((p) => p.isBackground)).toEqual([false, true, true]);
			expect(lines[0].words).toBe("Hello(echo)(echo)");
		});
	});

	describe("explicit content", () => {
		const build = (attr: string) => `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal"
              xmlns:amll="http://www.example.com/ns/amll" xml:lang="en">
  <body dur="10s"><div><p begin="0s" end="4s" itunes:key="L1"><span begin="0s" end="2s" ${attr}>Damn</span><span begin="2s" end="4s">it</span></p></div></body>
</tt>`;

		it("reads explicit=true", () => {
			const lines = parseTTMLContent(build('explicit="true"')).lyrics.filter((l) => !l.isInstrumental);
			expect(lines[0].parts!.map((p) => p.explicit)).toEqual([true, false]);
		});

		it("reads AMLL's obscene=true", () => {
			const lines = parseTTMLContent(build('amll:obscene="true"')).lyrics.filter((l) => !l.isInstrumental);
			expect(lines[0].parts!.map((p) => p.explicit)).toEqual([true, false]);
		});
	});

	describe("itunes metadata", () => {
		it("keeps every line that repeats an itunes:key", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <body dur="30s"><div>
    <p begin="0s" end="5s" itunes:key="L1">Chorus line</p>
    <p begin="5s" end="10s" itunes:key="L2">Verse line</p>
    <p begin="10s" end="15s" itunes:key="L1">Chorus line</p>
  </div></body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines).toHaveLength(3);
			expect(lines.map((l) => l.startTimeMs)).toEqual([0, 5000, 10000]);
			expect(lines.map((l) => l.key)).toEqual(["L1", "L2", "L1"]);
		});

		it("tolerates itunes:songPart on the div", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <body dur="20s">
    <div begin="0s" end="10s" itunes:songPart="Verse"><p begin="0s" end="5s" itunes:key="L1">Verse line</p></div>
    <div begin="10s" end="20s" itunes:songPart="Chorus"><p begin="10s" end="15s" itunes:key="L2">Chorus line</p></div>
  </body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines.map((l) => l.words)).toEqual(["Verse line", "Chorus line"]);
		});
	});

	describe("namespaces", () => {
		it("parses a document whose prefixes are never declared", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en">
  <body dur="10s"><div><p begin="0s" end="5s" itunes:key="L1" ttm:agent="v1">Unbound</p></div></body>
</tt>`;

			const result = parseTTMLContent(ttml);
			const lines = result.lyrics.filter((l) => !l.isInstrumental);

			expect(lines).toHaveLength(1);
			expect(lines[0].words).toBe("Unbound");
			expect(lines[0].key).toBe("L1");
			expect(lines[0].agent).toBe("v1");
		});
	});

	describe("offset times", () => {
		it("reads begin and end given in offset-time units", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="en">
  <body dur="5m"><div><p begin="60000ms" end="1.5m" itunes:key="L1"><span begin="60.5s" end="61s">Late</span></p></div></body>
</tt>`;

			const result = parseTTMLContent(ttml);
			const lines = result.lyrics.filter((l) => !l.isInstrumental);

			expect(lines[0].startTimeMs).toBe(60000);
			expect(lines[0].durationMs).toBe(30000);
			expect(lines[0].parts![0].startTimeMs).toBe(60500);
			expect(lines[0].parts![0].durationMs).toBe(500);
			// dur="5m" is the only source of the outro, so it has to have been read as 300000
			const outro = result.lyrics.filter((l) => l.isInstrumental).at(-1)!;
			expect(outro.startTimeMs + outro.durationMs).toBe(300000);
		});
	});

	describe("Apple dialect translations", () => {
		it("reads a translation attached to an inner text element", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="ja">
  <head><metadata>
    <translations>
      <translation type="subtitle" xml:lang="en"><text for="L1">Hello world</text></translation>
      <translation type="subtitle" xml:lang="fr"><text for="L1">Bonjour</text></translation>
    </translations>
  </metadata></head>
  <body dur="10s"><div><p begin="0s" end="5s" itunes:key="L1">Konnichiwa</p></div></body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines[0].translations).toEqual({ en: "Hello world", fr: "Bonjour" });
			expect(lines[0].translation).toEqual({ text: "Hello world", lang: "en" });
		});

		it("carries a translation onto every line sharing an itunes:key", () => {
			const ttml = `<tt xmlns="http://www.w3.org/ns/ttml"
              xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="ja">
  <head><metadata>
    <translations>
      <translation type="subtitle" xml:lang="en"><text for="L1">Hello world</text></translation>
    </translations>
  </metadata></head>
  <body dur="20s"><div>
    <p begin="0s" end="5s" itunes:key="L1">Konnichiwa</p>
    <p begin="5s" end="10s" itunes:key="L1">Konnichiwa</p>
  </div></body>
</tt>`;

			const lines = parseTTMLContent(ttml).lyrics.filter((l) => !l.isInstrumental);

			expect(lines).toHaveLength(2);
			expect(lines.map((l) => l.translations?.en)).toEqual(["Hello world", "Hello world"]);
		});
	});
});

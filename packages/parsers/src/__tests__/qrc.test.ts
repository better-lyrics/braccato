import { describe, expect, it } from "vitest";
import { QRCParser, parseQRC } from "../qrc.js";

describe("QRCParser", () => {
	describe("detect", () => {
		it("detects QRC format", () => {
			expect(QRCParser.detect("[1000,3000]Hello(1000,500) world(1500,500)")).toBe(true);
		});

		it("rejects LRC format", () => {
			expect(QRCParser.detect("[00:12.50]Hello world")).toBe(false);
		});

		it("detects a QQ Music envelope whose body is still escaped", () => {
			const envelope = `<?xml version="1.0" encoding="utf-8"?>
<QrcInfos>
  <LyricInfo LyricCount="1">
    <Lyric_1 LyricType="1" LyricContent="[1000,2000]Hello(1000,1000)"/>
  </LyricInfo>
</QrcInfos>`;
			expect(QRCParser.detect(envelope)).toBe(true);
		});

		it("detects an envelope even when the body carries no word timings", () => {
			const envelope = `<QrcInfos><LyricInfo><Lyric_1 LyricContent="[1000,2000]Hello world"/></LyricInfo></QrcInfos>`;
			expect(QRCParser.detect(envelope)).toBe(true);
		});
	});

	describe("parse", () => {
		it("parses QRC with word timing", () => {
			const qrc = "[1000,3000]Hello(1000,500) world(1500,1500)";

			const result = QRCParser.parse(qrc);

			expect(result).toHaveLength(1);
			expect(result[0].startTimeMs).toBe(1000);
			expect(result[0].durationMs).toBe(3000);
			expect(result[0].words).toBe("Hello world");
			expect(result[0].parts).toHaveLength(2);
			expect(result[0].parts![0].words).toBe("Hello");
			expect(result[0].parts![0].startTimeMs).toBe(1000);
			expect(result[0].parts![0].durationMs).toBe(500);
		});

		it("handles multiple lines", () => {
			const qrc = `[1000,2000]First(1000,1000) line(2000,1000)
[5000,3000]Second(5000,1500) line(6500,1500)`;

			const result = QRCParser.parse(qrc);

			expect(result).toHaveLength(2);
			expect(result[1].startTimeMs).toBe(5000);
		});

		it("handles empty input", () => {
			expect(QRCParser.parse("")).toEqual([]);
		});
	});

	describe("QrcInfos envelope", () => {
		it("parses the body out of a LyricContent attribute", () => {
			const envelope = `<?xml version="1.0" encoding="utf-8"?>
<QrcInfos>
  <QrcHeadInfo SaveTime="0" Version="100"/>
  <LyricInfo LyricCount="1">
    <Lyric_1 LyricType="1" LyricContent="[1000,2000]Hello(1000,1000)world(2000,1000)
[4000,2000]Second(4000,1000)line(5000,1000)
"/>
  </LyricInfo>
</QrcInfos>`;

			const result = parseQRC(envelope, 10000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(2);
			expect(sung[0].startTimeMs).toBe(1000);
			expect(sung[0].words).toBe("Helloworld");
			expect(sung[0].parts).toHaveLength(2);
			expect(sung[1].startTimeMs).toBe(4000);
		});

		it("unescapes &quot; and &amp; in the envelope body", () => {
			const envelope = `<QrcInfos><LyricInfo><Lyric_1 LyricContent="[1000,2000]&quot;Quoted&quot;(1000,1000) &amp;more(2000,1000)"/></LyricInfo></QrcInfos>`;

			const result = parseQRC(envelope, 10000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(1);
			expect(sung[0].words).toBe('"Quoted" &more');
			expect(sung[0].parts![0].words).toBe('"Quoted"');
			expect(sung[0].parts![1].words).toBe(" &more");
		});

		it("skips the bracketed metadata tags a QQ Music body carries", () => {
			const body = `[ti:Some Song]
[ar:Some Artist]
[1000,2000]Real(1000,1000)line(2000,1000)`;

			const result = parseQRC(body, 10000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(1);
			expect(sung[0].words).toBe("Realline");
		});
	});

	describe("singers", () => {
		it("lifts a leading Name: into an agent and strips it from the text", () => {
			const body = "[1000,2000]Alice:(1000,100)Hello (1100,900)there(2000,1000)";

			const result = parseQRC(body, 10000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(1);
			expect(sung[0].agent).toBe("v1");
			expect(sung[0].words).toBe("Hello there");
			expect(sung[0].parts).toHaveLength(2);
			expect(sung[0].startTimeMs).toBe(1100);
		});

		it("keeps the last named singer on the lines that follow", () => {
			const body = `[1000,2000]Alice:(1000,100)Hello (1100,900)there(2000,1000)
[4000,2000]world(4000,2000)
[7000,2000]Bob:(7000,100)Bye(7100,1900)
[10000,2000]now(10000,2000)`;

			const result = parseQRC(body, 20000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung.map((l) => l.agent)).toEqual(["v1", "v1", "v2", "v2"]);
		});

		it("maps a group singer to the v1000 slot", () => {
			const body = `[1000,2000]Alice:(1000,100)Solo(1100,1900)
[4000,2000]合:(4000,100)Together(4100,1900)
[7000,2000]ALL:(7000,100)Everyone(7100,1900)`;

			const result = parseQRC(body, 20000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung.map((l) => l.agent)).toEqual(["v1", "v1000", "v1000"]);
			expect(sung[1].words).toBe("Together");
		});

		it("drops credit lines instead of reading them as singers", () => {
			const body = `[0,3000]作词:(0,1500)张三(1500,1500)
[3000,2000]Produced by:(3000,500)Someone(3500,1500)
[6000,2000]Real(6000,1000)lyric(7000,1000)`;

			const result = parseQRC(body, 20000);
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(1);
			expect(sung[0].words).toBe("Reallyric");
		});
	});

	describe("title echo filtering", () => {
		it("drops an opening line that repeats the title and artist", () => {
			const body = `[0,2000]Bohemian(0,400) Rhapsody(400,400) -(800,400) Queen(1200,800)
[3000,2000]Is(3000,1000) this(4000,1000)`;

			const result = parseQRC(body, 20000, { title: "Bohemian Rhapsody", artist: "Queen" });
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(1);
			expect(sung[0].words).toBe("Is this");
		});

		it("keeps a title echo that appears after the opening lines", () => {
			const body = `[0,1000]One(0,400) two(400,600)
[1000,1000]Three(1000,400) four(1400,600)
[2000,1000]Five(2000,400) six(2400,600)
[3000,1000]Seven(3000,400) eight(3400,600)
[4000,1000]Nine(4000,400) ten(4400,600)
[5000,2000]Bohemian(5000,400) Rhapsody(5400,1600)`;

			const result = parseQRC(body, 20000, { title: "Bohemian Rhapsody", artist: "Queen" });
			const sung = result.filter((l) => !l.isInstrumental);

			expect(sung).toHaveLength(6);
			expect(sung[5].words).toBe("Bohemian Rhapsody");
		});
	});

	describe("instrumental breaks", () => {
		it("fills a long silence between lines", () => {
			const body = `[0,2000]First(0,1000) line(1000,1000)
[20000,2000]Second(20000,1000) line(21000,1000)`;

			const result = parseQRC(body, 40000);
			const instrumentals = result.filter((l) => l.isInstrumental);

			expect(instrumentals).toHaveLength(2);
			expect(instrumentals[0].startTimeMs).toBe(2000);
			expect(instrumentals[0].durationMs).toBe(18000);
			expect(instrumentals[1].startTimeMs).toBe(22000);
		});
	});
});

import { describe, expect, it } from "vitest";
import { QRCParser } from "../qrc.js";

describe("QRCParser", () => {
	describe("detect", () => {
		it("detects QRC format", () => {
			expect(QRCParser.detect("[1000,3000]Hello(1000,500) world(1500,500)")).toBe(true);
		});

		it("rejects LRC format", () => {
			expect(QRCParser.detect("[00:12.50]Hello world")).toBe(false);
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
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { splitPart } from "../split-part.js";

describe("splitPart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("does not split short English words", () => {
		const result = splitPart({ startTimeMs: 0, words: "hello", durationMs: 100 });
		expect(result).toHaveLength(1);
		expect(result[0].words).toBe("hello");
		expect(result[0].isWrapAfter).toBe(false);
	});

	it("does not split parts containing internal whitespace", () => {
		const result = splitPart({ startTimeMs: 0, words: "hello world", durationMs: 100 });
		expect(result).toHaveLength(1);
		expect(result[0].words).toBe("hello world");
	});

	it("does not split parts containing dash punctuation", () => {
		const result = splitPart({ startTimeMs: 0, words: "well-being", durationMs: 100 });
		expect(result).toHaveLength(1);
		expect(result[0].words).toBe("well-being");
	});

	it("does not split single long Latin words into characters", () => {
		const result = splitPart({ startTimeMs: 0, words: "clouds", durationMs: 100 });
		expect(result).toHaveLength(1);
		expect(result[0].words).toBe("clouds");
		expect(result[0].isWrapAfter).toBe(false);
	});

	it("does not split single long Cyrillic words into characters", () => {
		const result = splitPart({ startTimeMs: 0, words: "привет", durationMs: 100 });
		expect(result).toHaveLength(1);
		expect(result[0].words).toBe("привет");
	});

	it("segments a long space-less Japanese line into multiple sub-parts", () => {
		const input = "これはとても長い日本語の歌詞です";
		const result = splitPart({ startTimeMs: 0, words: input, durationMs: 1000 });

		expect(result.length).toBeGreaterThan(1);
		expect(result.map((p) => p.words).join("")).toBe(input);
	});

	it("ignores trailing whitespace when deciding whether to split", () => {
		const input = "これはとても長い日本語の歌詞です ";
		const result = splitPart({ startTimeMs: 0, words: input, durationMs: 1000 });

		expect(result.length).toBeGreaterThan(1);
		expect(result.map((p) => p.words).join("")).toBe(input);
	});

	it("falls back to grapheme granularity when word granularity returns one segment", () => {
		const input = "한국어가사도공백없이쭉이어지면자동으로줄바꿈이일어나야합니다";
		const result = splitPart({ startTimeMs: 0, words: input, durationMs: 1000 });

		expect(result.length).toBeGreaterThan(1);
		expect(result.map((p) => p.words).join("")).toBe(input);
	});

	it("marks isWrapAfter true on all sub-parts except the last", () => {
		const result = splitPart({ startTimeMs: 0, words: "これはとても長い日本語の歌詞です", durationMs: 300 });

		expect(result.length).toBeGreaterThan(1);
		for (let i = 0; i < result.length - 1; i++) {
			expect(result[i].isWrapAfter).toBe(true);
		}
		expect(result[result.length - 1].isWrapAfter).toBe(false);
	});

	it("interpolates timings so sub-parts span the parent duration", () => {
		const parent = { startTimeMs: 500, words: "これはとても長い日本語の歌詞です", durationMs: 1200 };
		const result = splitPart(parent);

		const totalDuration = result.reduce((sum, p) => sum + p.durationMs, 0);
		expect(Math.abs(totalDuration - parent.durationMs)).toBeLessThanOrEqual(1);
		expect(result[0].startTimeMs).toBe(parent.startTimeMs);

		for (let i = 1; i < result.length; i++) {
			expect(result[i].startTimeMs).toBeGreaterThan(result[i - 1].startTimeMs);
		}
	});

	it("falls back to code-point split when Intl.Segmenter throws", () => {
		vi.stubGlobal(
			"Intl",
			new Proxy(Intl, {
				get(target, prop) {
					if (prop === "Segmenter") {
						return class {
							constructor() {
								throw new Error("not supported");
							}
						};
					}
					return Reflect.get(target, prop);
				},
			}),
		);

		const result = splitPart({ startTimeMs: 0, words: "あいうえおかきくけこ", durationMs: 100 });

		expect(result.map((p) => p.words)).toEqual(["あ", "い", "う", "え", "お", "か", "き", "く", "け", "こ"]);
	});

	it("propagates isBackground from parent to every sub-part", () => {
		const result = splitPart({
			startTimeMs: 0,
			words: "これはとても長い日本語の歌詞です",
			durationMs: 200,
			isBackground: true,
		});

		expect(result.length).toBeGreaterThan(0);
		for (const sub of result) {
			expect(sub.isBackground).toBe(true);
		}
	});
});

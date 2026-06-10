import { afterEach, describe, expect, it, vi } from "vitest";
import { splitPart } from "../split-part.js";

describe("splitPart", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("segments an English sentence at word boundaries", () => {
		const result = splitPart({
			startTimeMs: 1000,
			words: "hello world",
			durationMs: 2000,
		});

		const text = result.map((p) => p.words).join("");
		expect(text).toBe("hello world");
		expect(result.length).toBeGreaterThanOrEqual(2);
		expect(result.some((p) => p.words === "hello")).toBe(true);
		expect(result.some((p) => p.words === "world")).toBe(true);
	});

	it("segments a space-less Japanese line into multiple sub-parts", () => {
		const input = "これはとても長い日本語の歌詞です";
		const result = splitPart({
			startTimeMs: 0,
			words: input,
			durationMs: 1000,
		});

		expect(result.length).toBeGreaterThan(1);
		expect(result.map((p) => p.words).join("")).toBe(input);
	});

	it("marks isWrapAfter true on all sub-parts except the last", () => {
		const result = splitPart({
			startTimeMs: 0,
			words: "alpha beta gamma",
			durationMs: 300,
		});

		expect(result.length).toBeGreaterThan(1);
		for (let i = 0; i < result.length - 1; i++) {
			expect(result[i].isWrapAfter).toBe(true);
		}
		expect(result[result.length - 1].isWrapAfter).toBe(false);
	});

	it("interpolates timings so sub-parts span the parent duration", () => {
		const parent = { startTimeMs: 500, words: "one two three four", durationMs: 1200 };
		const result = splitPart(parent);

		const totalDuration = result.reduce((sum, p) => sum + p.durationMs, 0);
		expect(Math.abs(totalDuration - parent.durationMs)).toBeLessThanOrEqual(1);
		expect(result[0].startTimeMs).toBe(parent.startTimeMs);

		for (let i = 1; i < result.length; i++) {
			expect(result[i].startTimeMs).toBeGreaterThan(result[i - 1].startTimeMs);
		}
	});

	it("marks hasTrailingSpace on segments ending in whitespace", () => {
		const result = splitPart({
			startTimeMs: 0,
			words: "hello world",
			durationMs: 100,
		});

		const helloPart = result.find((p) => p.words === "hello");
		const spacePart = result.find((p) => /\s/.test(p.words));
		expect(spacePart?.hasTrailingSpace).toBe(true);
		expect(helloPart?.hasTrailingSpace).toBe(false);
	});

	it("falls back to code-point split when Intl.Segmenter throws", () => {
		const SegmenterCtor = Intl.Segmenter;
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

		const result = splitPart({
			startTimeMs: 0,
			words: "abc",
			durationMs: 30,
		});

		expect(result.map((p) => p.words)).toEqual(["a", "b", "c"]);
		expect(SegmenterCtor).toBeDefined();
	});

	it("propagates isBackground from parent to every sub-part", () => {
		const result = splitPart({
			startTimeMs: 0,
			words: "ooh ooh",
			durationMs: 200,
			isBackground: true,
		});

		expect(result.length).toBeGreaterThan(0);
		for (const sub of result) {
			expect(sub.isBackground).toBe(true);
		}
	});

	it("yields a single sub-part with isWrapAfter=false for single-character input", () => {
		const result = splitPart({
			startTimeMs: 0,
			words: "あ",
			durationMs: 100,
		});

		expect(result).toHaveLength(1);
		expect(result[0].isWrapAfter).toBe(false);
		expect(result[0].words).toBe("あ");
	});
});

import { describe, expect, it } from "vitest";
import { createSimilarityValidator, stringSimilarity } from "../validation.js";

describe("stringSimilarity", () => {
	it("returns 1 for identical strings", () => {
		expect(stringSimilarity("hello world", "hello world")).toBe(1);
	});

	it("returns 0 for completely different strings", () => {
		expect(stringSimilarity("abc", "xyz")).toBe(0);
	});

	it("returns value between 0 and 1 for partial matches", () => {
		const score = stringSimilarity("hello world", "hello there");
		expect(score).toBeGreaterThan(0);
		expect(score).toBeLessThan(1);
	});

	it("is case insensitive by default", () => {
		expect(stringSimilarity("HELLO", "hello")).toBe(1);
	});

	it("can be case sensitive", () => {
		const score = stringSimilarity("HELLO", "hello", 2, true);
		expect(score).toBe(0);
	});

	it("returns 0 for strings shorter than substring length", () => {
		expect(stringSimilarity("a", "a", 2)).toBe(0);
	});

	it("handles empty strings", () => {
		expect(stringSimilarity("", "hello")).toBe(0);
		expect(stringSimilarity("hello", "")).toBe(0);
	});
});

describe("createSimilarityValidator", () => {
	const reference = "Hello world this is a test song with some lyrics";

	it("accepts similar lyrics", () => {
		const validate = createSimilarityValidator(reference, 0.5);
		const result = {
			lyrics: [{ startTimeMs: 0, words: "Hello world this is a test song with some lyrics", durationMs: 1000 }],
		};
		expect(validate(result)).toBe(true);
	});

	it("rejects dissimilar lyrics", () => {
		const validate = createSimilarityValidator(reference, 0.5);
		const result = {
			lyrics: [{ startTimeMs: 0, words: "Completely different text about nothing related", durationMs: 1000 }],
		};
		expect(validate(result)).toBe(false);
	});

	it("rejects null lyrics", () => {
		const validate = createSimilarityValidator(reference);
		expect(validate({ lyrics: null })).toBe(false);
	});

	it("rejects empty lyrics array", () => {
		const validate = createSimilarityValidator(reference);
		expect(validate({ lyrics: [] })).toBe(false);
	});

	it("respects custom threshold", () => {
		const strictValidate = createSimilarityValidator(reference, 0.9);
		const looseValidate = createSimilarityValidator(reference, 0.1);

		const result = {
			lyrics: [{ startTimeMs: 0, words: "Hello world something else entirely", durationMs: 1000 }],
		};

		expect(looseValidate(result)).toBe(true);
		expect(strictValidate(result)).toBe(false);
	});
});

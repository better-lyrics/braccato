import { describe, expect, it } from "vitest";
import { hasKana, isJapaneseLine, songHasKana } from "../detect.js";

describe("detect", () => {
	describe("hasKana", () => {
		it("returns true for hiragana and katakana", () => {
			expect(hasKana("こんにちは")).toBe(true);
			expect(hasKana("アイウエオ")).toBe(true);
			expect(hasKana("青空 (あおぞら)")).toBe(true);
		});

		it("returns false for non-kana text", () => {
			expect(hasKana("我爱你")).toBe(false);
			expect(hasKana("Hello world")).toBe(false);
			expect(hasKana("123456")).toBe(false);
		});
	});

	describe("songHasKana", () => {
		it("detects if any line in the song contains kana", () => {
			expect(songHasKana(["我爱你", "青空を見上げる"])).toBe(true);
			expect(songHasKana(["我爱你", "天空中的流星"])).toBe(false);
		});
	});

	describe("isJapaneseLine", () => {
		it("identifies lines with kana as Japanese regardless of language metadata", () => {
			expect(isJapaneseLine("青空を見上げる", { songHasKana: false })).toBe(true);
			expect(isJapaneseLine("青空を見上げる", { songHasKana: true, declaredLanguage: "zh" })).toBe(true);
		});

		it("identifies Han-only lines as Japanese if the song has kana and language is ja or unset", () => {
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: "ja" })).toBe(true);
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: "ja-JP" })).toBe(true);
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: undefined })).toBe(true);
		});

		it("rejects Han-only lines when the song contains no kana", () => {
			expect(isJapaneseLine("我爱你", { songHasKana: false, declaredLanguage: "ja" })).toBe(false);
			expect(isJapaneseLine("天空", { songHasKana: false, declaredLanguage: undefined })).toBe(false);
		});

		it("rejects Han-only lines when declared language is non-Japanese", () => {
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: "zh" })).toBe(false);
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: "zh-TW" })).toBe(false);
			expect(isJapaneseLine("運命", { songHasKana: true, declaredLanguage: "en" })).toBe(false);
		});
	});
});

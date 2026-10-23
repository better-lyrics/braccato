import { describe, expect, it } from "vitest";
import {
	alignLineByKanaAnchors,
	alignLineParts,
	alignWordWithReading,
	containsKanji,
	isPlausibleRuby,
	katakanaToHiragana,
	romajiToHiragana,
} from "../aligner.js";

describe("aligner", () => {
	describe("containsKanji", () => {
		it("detects presence of Kanji characters", () => {
			expect(containsKanji("こんにちは")).toBe(false);
			expect(containsKanji("Hello 123")).toBe(false);
			expect(containsKanji("私は学生です")).toBe(true);
			expect(containsKanji("運命")).toBe(true);
		});
	});

	describe("katakanaToHiragana", () => {
		it("converts katakana to hiragana and keeps chōonpu", () => {
			expect(katakanaToHiragana("アイウエオ")).toBe("あいうえお");
			expect(katakanaToHiragana("ラーメン")).toBe("らーめん");
		});
	});

	describe("romajiToHiragana", () => {
		it("converts basic romaji", () => {
			expect(romajiToHiragana("watashi")).toBe("わたし");
			expect(romajiToHiragana("sadame")).toBe("さだめ");
		});

		it("handles digraphs and compounds", () => {
			expect(romajiToHiragana("kyou")).toBe("きょう");
			expect(romajiToHiragana("shinjiru")).toBe("しんじる");
			expect(romajiToHiragana("jyurieta")).toBe("じゅりえた");
		});

		it("handles sokuon (geminate consonants and trailing consonants)", () => {
			expect(romajiToHiragana("kitto")).toBe("きっと");
			expect(romajiToHiragana("is")).toBe("いっ");
			expect(romajiToHiragana("it")).toBe("いっ");
		});

		it("handles double n and nasal n", () => {
			expect(romajiToHiragana("konna")).toBe("こんな");
		});

		it("handles macrons and circumflex long vowels", () => {
			expect(romajiToHiragana("tōkyō")).toBe("とうきょう");
			expect(romajiToHiragana("Tôkyô")).toBe("とうきょう");
		});

		it("converts common English loanwords", () => {
			expect(romajiToHiragana("devil")).toBe("でびる");
			expect(romajiToHiragana("heart")).toBe("はーと");
		});

		it("handles Hepburn syllabic m before b, p, m", () => {
			expect(romajiToHiragana("shimbun")).toBe("しんぶん");
			expect(romajiToHiragana("kampai")).toBe("かんぱい");
			expect(romajiToHiragana("sempai")).toBe("せんぱい");
		});

		it("preserves mimetic and native nya sequences", () => {
			expect(romajiToHiragana("gunyagunya")).toBe("ぐにゃぐにゃ");
			expect(romajiToHiragana("munyamunya")).toBe("むにゃむにゃ");
			expect(romajiToHiragana("honyarara")).toBe("ほにゃらら");
		});
	});

	describe("alignWordWithReading", () => {
		it("aligns pure kanji words", () => {
			const segments = alignWordWithReading("運命", "sadame");
			expect(segments).toEqual([{ text: "運命", ruby: "さだめ" }]);
		});

		it("aligns words with okurigana suffix", () => {
			const segments = alignWordWithReading("信じる", "shinjiru");
			expect(segments).toEqual([
				{ text: "信", ruby: "しん" },
				{ text: "じる", ruby: undefined },
			]);
		});

		it("splits known compound kanji when dictionary matches", () => {
			const segments = alignWordWithReading("笑顔", "egao");
			expect(segments).toEqual([
				{ text: "笑", ruby: "え" },
				{ text: "顔", ruby: "がお" },
			]);
		});

		it("preserves jukujikun readings as a single unit", () => {
			const segments = alignWordWithReading("今日", "kyou");
			expect(segments).toEqual([{ text: "今日", ruby: "きょう" }]);
		});

		it("splits long-vowel 2-kanji compounds without dictionary entry", () => {
			const segments = alignWordWithReading("感情", "kanjou");
			expect(segments).toEqual([
				{ text: "感", ruby: "かん" },
				{ text: "情", ruby: "じょう" },
			]);

			const fuuSegments = alignWordWithReading("風雨", "fuuu");
			expect(fuuSegments).toEqual([
				{ text: "風", ruby: "ふう" },
				{ text: "雨", ruby: "う" },
			]);
		});
	});

	describe("alignLineByKanaAnchors", () => {
		it("aligns lines with mixed kanji and kana anchors", () => {
			const text = "私の名前は運命を信じる";
			const reading = "わたしのなまえはさだめをしんじる";
			const segments = alignLineByKanaAnchors(text, reading);

			const withRuby = segments.filter((s) => s.ruby);
			expect(withRuby).toEqual([
				{ text: "私", ruby: "わたし" },
				{ text: "名前", ruby: "なまえ" },
				{ text: "運命", ruby: "さだめ" },
				{ text: "信", ruby: "しん" },
			]);
		});

		it("handles punctuation and brackets around kanji", () => {
			const text = "「君」の瞳に映る「世界」";
			const reading = "「きみ」のひとみにうつる「せかい」";
			const segments = alignLineByKanaAnchors(text, reading);

			const withRuby = segments.filter((s) => s.ruby);
			expect(withRuby).toEqual([
				{ text: "君", ruby: "きみ" },
				{ text: "瞳", ruby: "ひとみ" },
				{ text: "映", ruby: "うつ" },
				{ text: "世", ruby: "せ" },
				{ text: "界", ruby: "かい" },
			]);
		});

		it("treats kanji with explicit bracketed kana as atomic units", () => {
			const text = "運命(さだめ)を信じる";
			const reading = "さだめをしんじる";
			const segments = alignLineByKanaAnchors(text, reading);
			expect(segments).toEqual([
				{ text: "運命(さだめ)" },
				{ text: "を" },
				{ text: "信", ruby: "しん" },
				{ text: "じる" },
			]);
		});

		it("treats kanji with explicit bracketed kana as atomic units even when reading has brackets or full readings", () => {
			const text = "運命(さだめ)を信じる";
			const reading = "うんめい(さだめ)をしんじる";
			const segments = alignLineByKanaAnchors(text, reading);
			expect(segments).toEqual([
				{ text: "運命(さだめ)" },
				{ text: "を" },
				{ text: "信", ruby: "しん" },
				{ text: "じる" },
			]);
		});

		it("safely falls back to plain text when ruby mora count implausibly bleeds over", () => {
			const text = "世界";
			const implausibleReading = "せかいがおわるまでは";
			const segments = alignLineByKanaAnchors(text, implausibleReading);
			expect(segments).toEqual([{ text: "世界" }]);
		});

		it("does not match chōonpu ー as a particle anchor", () => {
			const text = "ルールを守る";
			const reading = "るーるをまもる";
			const segments = alignLineByKanaAnchors(text, reading);
			const mamoruSeg = segments.find((s) => s.text === "守");
			expect(mamoruSeg).toEqual({ text: "守", ruby: "まも" });
		});
	});

	describe("alignLineParts", () => {
		it("aligns timed romanization parts to line parts", () => {
			const parts = [
				{ words: "私", startTimeMs: 1000, durationMs: 400 },
				{ words: "は", startTimeMs: 1400, durationMs: 200 },
				{ words: "運命", startTimeMs: 1600, durationMs: 600 },
			];
			const timedRom = [
				{ words: "watashi", startTimeMs: 1000, durationMs: 400 },
				{ words: "wa", startTimeMs: 1400, durationMs: 200 },
				{ words: "sadame", startTimeMs: 1600, durationMs: 600 },
			];

			const result = alignLineParts(parts, timedRom);
			expect(result[0]).toEqual([{ text: "私", ruby: "わたし" }]);
			expect(result[1]).toEqual([{ text: "は", ruby: undefined }]);
			expect(result[2]).toEqual([{ text: "運命", ruby: "さだめ" }]);
		});

		it("aligns parts using full-line romanization when syllable timing is absent", () => {
			const parts = [
				{ words: "青い", startTimeMs: 0, durationMs: 500 },
				{ words: "空", startTimeMs: 500, durationMs: 500 },
			];
			const result = alignLineParts(parts, null, "aoi sora");
			expect(result[0]).toEqual([{ text: "青", ruby: "あお" }, { text: "い" }]);
			expect(result[1]).toEqual([{ text: "空", ruby: "そら" }]);
		});

		it("falls back gracefully when pronunciation is unavailable", () => {
			const parts = [
				{ words: "私", startTimeMs: 1000, durationMs: 400 },
				{ words: "は", startTimeMs: 1400, durationMs: 200 },
			];
			const result = alignLineParts(parts, null, null);
			expect(result[0]).toEqual([{ text: "私", ruby: undefined }]);
			expect(result[1]).toEqual([{ text: "は", ruby: undefined }]);
		});

		it("calculates timing offset against first vocal part instead of leading punctuation", () => {
			const parts = [
				{ words: "「", startTimeMs: 0, durationMs: 100 },
				{ words: "君", startTimeMs: 1000, durationMs: 500 },
				{ words: "」", startTimeMs: 1500, durationMs: 100 },
			];
			const timedRom = [{ words: "kimi", startTimeMs: 1100, durationMs: 500 }];
			const result = alignLineParts(parts, timedRom);
			expect(result[1]).toEqual([{ text: "君", ruby: "きみ" }]);
		});

		it("preserves valid timed alignments when global line alignment fails", () => {
			// Suppose we have a 2-part line where part 0 has valid timed rom and part 1 has something that causes global failure
			const parts = [
				{ words: "君", startTimeMs: 1000, durationMs: 500 },
				{ words: "の瞳", startTimeMs: 1500, durationMs: 500 },
			];
			const timedRom = [
				{ words: "kimi", startTimeMs: 1000, durationMs: 500 },
				{ words: "nohitomi", startTimeMs: 1500, durationMs: 500 },
			];
			const result = alignLineParts(parts, timedRom);
			expect(result[0]).toEqual([{ text: "君", ruby: "きみ" }]);
			expect(result[1]).toEqual([{ text: "の" }, { text: "瞳", ruby: "ひとみ" }]);
		});

		it("rejects implausible ruby assignments", () => {
			expect(isPlausibleRuby("空", "そら")).toBe(true);
			expect(isPlausibleRuby("空", "あいうえおかきくけこ")).toBe(false);
			expect(isPlausibleRuby("空", "")).toBe(false);
			expect(isPlausibleRuby("100年", "ひゃくねん")).toBe(true);
			expect(isPlausibleRuby("1人", "ひとり")).toBe(true);
		});
	});
});

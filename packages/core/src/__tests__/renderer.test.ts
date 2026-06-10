import { describe, expect, it } from "vitest";
import { renderLyrics } from "../renderer.js";
import type { Lyric } from "../types.js";

function makeLyric(words: string): Lyric {
	return { startTimeMs: 0, words, durationMs: 1000 };
}

describe("renderLyrics", () => {
	it("produces multiple wrappable group spans for a space-less Japanese line", () => {
		const container = document.createElement("div");
		const lyrics: Lyric[] = [
			makeLyric("これはとても長い日本語の歌詞でスペースが入っていないため横幅を超えたときに自然改行されてほしい"),
		];

		renderLyrics(lyrics, container);

		const line = container.querySelector(".braccato--line") as HTMLDivElement;
		expect(line).toBeTruthy();
		const groupSpans = line.querySelectorAll(":scope > span");
		expect(groupSpans.length).toBeGreaterThan(1);
	});

	it("produces multiple wrappable group spans for a space-separated English line", () => {
		const container = document.createElement("div");
		const lyrics: Lyric[] = [makeLyric("the quick brown fox jumps over the lazy dog")];

		renderLyrics(lyrics, container);

		const line = container.querySelector(".braccato--line") as HTMLDivElement;
		const groupSpans = line.querySelectorAll(":scope > span");
		expect(groupSpans.length).toBeGreaterThan(1);
	});

	it("applies the trailing-space class on the last sub-part of source parts that end in whitespace", () => {
		const container = document.createElement("div");
		const lyrics: Lyric[] = [
			{
				startTimeMs: 0,
				durationMs: 1000,
				words: "hello world",
				parts: [
					{ startTimeMs: 0, words: "hello ", durationMs: 500 },
					{ startTimeMs: 500, words: "world", durationMs: 500 },
				],
			},
		];

		renderLyrics(lyrics, container);

		const line = container.querySelector(".braccato--line") as HTMLDivElement;
		const trailing = line.querySelectorAll(".braccato--has-trailing-space");
		expect(trailing.length).toBeGreaterThanOrEqual(1);
	});

	it("does not apply trailing-space class on the final source part with no trailing whitespace", () => {
		const container = document.createElement("div");
		const lyrics: Lyric[] = [
			{
				startTimeMs: 0,
				durationMs: 1000,
				words: "hello world",
				parts: [
					{ startTimeMs: 0, words: "hello ", durationMs: 500 },
					{ startTimeMs: 500, words: "world", durationMs: 500 },
				],
			},
		];

		renderLyrics(lyrics, container);

		const line = container.querySelector(".braccato--line") as HTMLDivElement;
		const wordSpans = Array.from(line.querySelectorAll(".braccato--word")) as HTMLSpanElement[];
		const worldSpan = wordSpans.find((s) => s.textContent === "world");
		expect(worldSpan?.classList.contains("braccato--has-trailing-space")).toBe(false);
	});
});

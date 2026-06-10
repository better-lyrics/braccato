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

	it("does not segment English word parts (one word span per source part)", () => {
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
		const wordSpans = line.querySelectorAll(".braccato--word");
		expect(wordSpans.length).toBe(2);
		expect(wordSpans[0].textContent).toBe("hello ");
		expect(wordSpans[1].textContent).toBe("world");
	});

	it("does not add splitter wrap markers to short English parts", () => {
		const container = document.createElement("div");
		const lyrics: Lyric[] = [
			{
				startTimeMs: 0,
				durationMs: 1000,
				words: "hello",
				parts: [{ startTimeMs: 0, words: "hello", durationMs: 1000 }],
			},
		];

		renderLyrics(lyrics, container);

		const line = container.querySelector(".braccato--line") as HTMLDivElement;
		const wordSpans = line.querySelectorAll(".braccato--word");
		for (const span of wordSpans) {
			expect((span as HTMLElement).dataset.wrapAfter).toBeUndefined();
		}
	});
});

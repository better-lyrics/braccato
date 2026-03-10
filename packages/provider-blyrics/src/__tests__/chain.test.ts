import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderChain } from "../chain.js";
import type { LyricSourceResult, ProviderContext, ProviderRegistration } from "../types.js";

function makeCtx(overrides: Partial<ProviderContext> = {}): ProviderContext {
	return {
		song: "Test Song",
		artist: "Test Artist",
		duration: 200,
		signal: new AbortController().signal,
		...overrides,
	};
}

function makeResult(words = "Hello"): LyricSourceResult {
	return {
		lyrics: [{ startTimeMs: 0, words, durationMs: 1000 }],
		source: "test",
		sourceHref: "https://test.com",
	};
}

function makeProvider(
	key: string,
	result: LyricSourceResult | null,
	syncType: "syllable" | "word" | "line" | "unsynced" = "line",
): ProviderRegistration {
	return {
		key,
		displayName: key,
		syncType,
		fetch: vi.fn().mockResolvedValue(result),
	};
}

describe("ProviderChain", () => {
	let chain: ProviderChain;

	beforeEach(() => {
		chain = new ProviderChain();
	});

	describe("register / unregister", () => {
		it("registers providers", () => {
			chain.register(makeProvider("a", makeResult()));
			expect(chain.getRegistered()).toHaveLength(1);
		});

		it("unregisters providers", () => {
			chain.register(makeProvider("a", makeResult()));
			chain.unregister("a");
			expect(chain.getRegistered()).toHaveLength(0);
		});
	});

	describe("fetchLyrics", () => {
		it("returns first successful result", async () => {
			chain.register(makeProvider("a", makeResult("From A")));
			chain.register(makeProvider("b", makeResult("From B")));

			const result = await chain.fetchLyrics(makeCtx());

			expect(result).not.toBeNull();
			expect(result!.lyrics![0].words).toBe("From A");
		});

		it("skips null results and tries next", async () => {
			chain.register(makeProvider("a", null, "syllable"));
			chain.register(makeProvider("b", makeResult("From B"), "word"));

			const result = await chain.fetchLyrics(makeCtx());

			expect(result!.lyrics![0].words).toBe("From B");
		});

		it("skips empty lyrics arrays", async () => {
			chain.register(makeProvider("a", { lyrics: [], source: "x", sourceHref: "x" }, "syllable"));
			chain.register(makeProvider("b", makeResult("From B"), "word"));

			const result = await chain.fetchLyrics(makeCtx());

			expect(result!.lyrics![0].words).toBe("From B");
		});

		it("returns null if all providers fail", async () => {
			chain.register(makeProvider("a", null));
			chain.register(makeProvider("b", null));

			const result = await chain.fetchLyrics(makeCtx());

			expect(result).toBeNull();
		});

		it("respects custom priority order", async () => {
			chain.register(makeProvider("a", makeResult("From A"), "syllable"));
			chain.register(makeProvider("b", makeResult("From B"), "line"));

			const result = await chain.fetchLyrics(makeCtx(), {
				priority: ["b", "a"],
			});

			expect(result!.lyrics![0].words).toBe("From B");
		});

		it("skips disabled providers", async () => {
			chain.register(makeProvider("a", makeResult("From A"), "syllable"));
			chain.register(makeProvider("b", makeResult("From B"), "word"));

			const result = await chain.fetchLyrics(makeCtx(), {
				disabled: new Set(["a"]),
			});

			expect(result!.lyrics![0].words).toBe("From B");
		});

		it("applies validation function", async () => {
			chain.register(makeProvider("a", makeResult("Wrong lyrics"), "syllable"));
			chain.register(makeProvider("b", makeResult("Correct lyrics"), "word"));

			const result = await chain.fetchLyrics(makeCtx(), {
				validate: (r) => r.lyrics![0].words.includes("Correct"),
			});

			expect(result!.lyrics![0].words).toBe("Correct lyrics");
		});

		it("calls onProviderResult callback", async () => {
			const onResult = vi.fn();
			chain.register(makeProvider("a", makeResult()));

			await chain.fetchLyrics(makeCtx(), { onProviderResult: onResult });

			expect(onResult).toHaveBeenCalledWith("a", expect.objectContaining({ source: "test" }));
		});

		it("calls onProviderError callback on error", async () => {
			const onError = vi.fn();
			const errorProvider: ProviderRegistration = {
				key: "bad",
				displayName: "bad",
				syncType: "line",
				fetch: vi.fn().mockRejectedValue(new Error("API down")),
			};
			chain.register(errorProvider);

			const result = await chain.fetchLyrics(makeCtx(), { onProviderError: onError });

			expect(result).toBeNull();
			expect(onError).toHaveBeenCalledWith("bad", expect.any(Error));
		});

		it("caches provider results to avoid duplicate fetches", async () => {
			const provider = makeProvider("a", makeResult());
			chain.register(provider);

			await chain.fetchLyrics(makeCtx());
			await chain.fetchLyrics(makeCtx());

			expect(provider.fetch).toHaveBeenCalledTimes(1);
		});

		it("clearCache allows refetching", async () => {
			const provider = makeProvider("a", makeResult());
			chain.register(provider);

			await chain.fetchLyrics(makeCtx());
			chain.clearCache();
			await chain.fetchLyrics(makeCtx());

			expect(provider.fetch).toHaveBeenCalledTimes(2);
		});

		it("returns null on aborted signal", async () => {
			const controller = new AbortController();
			controller.abort();

			chain.register(makeProvider("a", makeResult()));

			const result = await chain.fetchLyrics(makeCtx({ signal: controller.signal }));

			expect(result).toBeNull();
		});
	});

	describe("default priority", () => {
		it("sorts by sync type: syllable > word > line > unsynced", async () => {
			const calls: string[] = [];

			const mkTracked = (key: string, syncType: "syllable" | "word" | "line" | "unsynced"): ProviderRegistration => ({
				key,
				displayName: key,
				syncType,
				fetch: vi.fn().mockImplementation(async () => {
					calls.push(key);
					return null;
				}),
			});

			chain.register(mkTracked("unsynced", "unsynced"));
			chain.register(mkTracked("syllable", "syllable"));
			chain.register(mkTracked("line", "line"));
			chain.register(mkTracked("word", "word"));

			await chain.fetchLyrics(makeCtx());

			expect(calls).toEqual(["syllable", "word", "line", "unsynced"]);
		});
	});
});

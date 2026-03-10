import { TTMLParser } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://lyrics-api.boidu.dev/getLyrics";

export interface BLyricsProviderOptions {
	apiUrl?: string;
	timeout?: number;
}

export function createBLyricsProvider(options: BLyricsProviderOptions = {}): ProviderFn {
	const { apiUrl = DEFAULT_API_URL, timeout = 10000 } = options;

	return async (ctx): Promise<LyricSourceResult | null> => {
		const url = new URL(apiUrl);
		url.searchParams.append("s", ctx.song);
		url.searchParams.append("a", ctx.artist);
		url.searchParams.append("d", String(ctx.duration));
		if (ctx.album) url.searchParams.append("al", ctx.album);

		const response = await fetch(url.toString(), {
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
		});

		if (!response.ok) return null;

		const json = await response.json();
		const ttml = json.ttml;
		if (!ttml) return null;

		const lyrics = TTMLParser.parse(ttml);
		if (!lyrics || lyrics.length === 0) return null;

		const hasWordSync = lyrics.some((l) => l.parts?.some((p) => p.durationMs > 0));

		return {
			lyrics,
			language: json.lang ?? undefined,
			source: "boidu.dev",
			sourceHref: "https://boidu.dev/",
			cacheAllowed: true,
			musicVideoSynced: false,
		};
	};
}

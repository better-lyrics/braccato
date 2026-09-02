import { TTMLParser } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://lyrics-api.binimum.org/";

interface BinimumResult {
	timing_type?: string;
	lyricsUrl?: string;
}

export interface BinimumProviderOptions {
	apiUrl?: string;
	timeout?: number;
}

export function createBinimumProvider(options: BinimumProviderOptions = {}): ProviderFn {
	const { apiUrl = DEFAULT_API_URL, timeout = 10000 } = options;

	return async (ctx): Promise<LyricSourceResult | null> => {
		const signal = () => AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]);

		const searchUrl = new URL(apiUrl);
		searchUrl.searchParams.append("track", ctx.song);
		searchUrl.searchParams.append("artist", ctx.artist);
		searchUrl.searchParams.append("duration", String(Math.round(ctx.duration)));
		if (ctx.album) searchUrl.searchParams.append("album", ctx.album);

		const searchResponse = await fetch(searchUrl.toString(), { signal: signal() });
		if (!searchResponse.ok) return null;

		const searchData = await searchResponse.json();
		const selected: BinimumResult | undefined = searchData.results?.[0];
		if (!selected?.lyricsUrl) return null;

		const ttmlResponse = await fetch(selected.lyricsUrl, { signal: signal() });
		if (!ttmlResponse.ok) return null;

		const lyrics = TTMLParser.parse(await ttmlResponse.text());
		if (lyrics.length === 0) return null;

		return {
			lyrics,
			source: "BiniLyrics",
			sourceHref: "https://lyrics-api.binimum.org/",
			cacheAllowed: true,
		};
	};
}

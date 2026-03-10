import { LRCParser } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://lyrics-api.boidu.dev/kugou/getLyrics";

export interface LegatoProviderOptions {
	apiUrl?: string;
	timeout?: number;
}

export function createLegatoProvider(options: LegatoProviderOptions = {}): ProviderFn {
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

		const data = await response.json();
		if (!data.lyrics) return null;

		const lyrics = LRCParser.parse(data.lyrics, ctx.duration * 1000);
		if (lyrics.length === 0) return null;

		return {
			lyrics,
			source: "Better Lyrics Legato",
			sourceHref: "https://boidu.dev/",
			cacheAllowed: true,
		};
	};
}

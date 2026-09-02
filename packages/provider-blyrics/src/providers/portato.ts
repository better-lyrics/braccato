import { parseQRC } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://lyrics-api.boidu.dev/qq/getLyrics";

export interface PortatoProviderOptions {
	apiUrl?: string;
	timeout?: number;
}

export function createPortatoProvider(options: PortatoProviderOptions = {}): ProviderFn {
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
		if (!data.lyrics || data.error) return null;

		const lyrics = parseQRC(data.lyrics, ctx.duration * 1000, {
			title: ctx.song,
			artist: ctx.artist,
		});
		if (lyrics.length === 0) return null;

		return {
			lyrics,
			source: "Better Lyrics Portato",
			sourceHref: "https://boidu.dev/",
			musicVideoSynced: false,
			cacheAllowed: true,
		};
	};
}

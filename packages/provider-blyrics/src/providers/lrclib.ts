import { LRCParser, PlainParser } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://lrclib.net/api/get";
const DEFAULT_CLIENT_HEADER = "Braccato (https://github.com/braccato)";

export interface LRCLibProviderOptions {
	apiUrl?: string;
	clientHeader?: string;
	timeout?: number;
}

export function createLRCLibSyncedProvider(options: LRCLibProviderOptions = {}): ProviderFn {
	const { apiUrl = DEFAULT_API_URL, clientHeader = DEFAULT_CLIENT_HEADER, timeout = 10000 } = options;

	return async (ctx): Promise<LyricSourceResult | null> => {
		const url = new URL(apiUrl);
		url.searchParams.append("track_name", ctx.song);
		url.searchParams.append("artist_name", ctx.artist);
		if (ctx.album) url.searchParams.append("album_name", ctx.album);
		url.searchParams.append("duration", String(ctx.duration));

		const response = await fetch(url.toString(), {
			headers: { "Lrclib-Client": clientHeader },
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
		});

		if (!response.ok) return null;

		const data = await response.json();

		if (data.syncedLyrics) {
			const lyrics = LRCParser.parse(data.syncedLyrics, ctx.duration * 1000);
			if (lyrics.length > 0) {
				return {
					lyrics,
					source: "LRCLib",
					sourceHref: "https://lrclib.net/",
					cacheAllowed: true,
				};
			}
		}

		return null;
	};
}

export function createLRCLibPlainProvider(options: LRCLibProviderOptions = {}): ProviderFn {
	const { apiUrl = DEFAULT_API_URL, clientHeader = DEFAULT_CLIENT_HEADER, timeout = 10000 } = options;

	return async (ctx): Promise<LyricSourceResult | null> => {
		const url = new URL(apiUrl);
		url.searchParams.append("track_name", ctx.song);
		url.searchParams.append("artist_name", ctx.artist);
		if (ctx.album) url.searchParams.append("album_name", ctx.album);
		url.searchParams.append("duration", String(ctx.duration));

		const response = await fetch(url.toString(), {
			headers: { "Lrclib-Client": clientHeader },
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
		});

		if (!response.ok) return null;

		const data = await response.json();

		if (data.plainLyrics) {
			const lyrics = PlainParser.parse(data.plainLyrics);
			if (lyrics.length > 0) {
				return {
					lyrics,
					source: "LRCLib",
					sourceHref: "https://lrclib.net/",
					cacheAllowed: false,
				};
			}
		}

		return null;
	};
}

import { LRCParser, type LyricParser, PlainParser, TTMLParser } from "@braccato/parsers";
import type { LyricSourceResult, ProviderFn } from "../types.js";

const DEFAULT_API_URL = "https://unison.boidu.dev/lyrics";
const DEFAULT_SOURCE_HREF = "https://unison.boidu.dev/";

const PARSERS: Record<NonNullable<UnisonData["format"]>, LyricParser> = {
	ttml: TTMLParser,
	lrc: LRCParser,
	plain: PlainParser,
};

interface UnisonData {
	format?: "ttml" | "lrc" | "plain";
	lyrics?: string;
}

export interface UnisonProviderOptions {
	apiUrl?: string;
	sourceHref?: string;
	keyId?: string;
	timeout?: number;
}

export function createUnisonProvider(options: UnisonProviderOptions = {}): ProviderFn {
	const { apiUrl = DEFAULT_API_URL, sourceHref = DEFAULT_SOURCE_HREF, keyId, timeout = 10000 } = options;

	return async (ctx): Promise<LyricSourceResult | null> => {
		const url = new URL(apiUrl);
		if (ctx.videoId) url.searchParams.append("v", ctx.videoId);
		url.searchParams.append("song", ctx.song);
		url.searchParams.append("artist", ctx.artist);
		url.searchParams.append("duration", String(Math.round(ctx.duration)));
		if (ctx.album) url.searchParams.append("album", ctx.album);

		const response = await fetch(url.toString(), {
			headers: keyId ? { "x-key-id": keyId } : undefined,
			signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeout)]),
		});

		if (!response.ok) return null;

		const data: UnisonData | undefined = await response.json().then((json) => json?.data);
		if (!data?.format || !data.lyrics) return null;

		const parser = Object.hasOwn(PARSERS, data.format) ? PARSERS[data.format] : undefined;
		if (!parser) return null;

		const lyrics = parser.parse(data.lyrics, ctx.duration * 1000);
		if (lyrics.length === 0) return null;

		return {
			lyrics,
			songwriters: parser.metadata(data.lyrics).songwriters,
			source: "Unison",
			sourceHref,
			cacheAllowed: false,
		};
	};
}

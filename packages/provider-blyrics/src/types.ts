import type { Lyric } from "@braccato/parsers";

export interface LyricSourceResult {
	lyrics: Lyric[] | null;
	language?: string | null;
	source: string;
	sourceHref: string;
	musicVideoSynced?: boolean | null;
	cacheAllowed?: boolean;
}

export interface ProviderConfig {
	key: string;
	displayName: string;
	syncType: "syllable" | "word" | "line" | "unsynced";
	priority: number;
	enabled: boolean;
}

export interface ProviderContext {
	song: string;
	artist: string;
	duration: number;
	album?: string | null;
	signal: AbortSignal;
}

export type ProviderFn = (ctx: ProviderContext) => Promise<LyricSourceResult | null>;

export interface ProviderRegistration {
	key: string;
	displayName: string;
	syncType: "syllable" | "word" | "line" | "unsynced";
	fetch: ProviderFn;
}

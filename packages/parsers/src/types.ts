export interface Lyric {
	startTimeMs: number;
	words: string;
	durationMs: number;
	key?: string;
	parts?: LyricPart[];
	agent?: string;
	translation?: { text: string; lang: string };
	romanization?: string;
	timedRomanization?: LyricPart[];
	isInstrumental?: boolean;
}

export interface LyricPart {
	startTimeMs: number;
	words: string;
	durationMs: number;
	isBackground?: boolean;
}

export type SyncType = "richsync" | "synced" | "none";

export interface LyricParser {
	parse(input: string, duration?: number): Lyric[];
	detect(input: string): boolean;
}

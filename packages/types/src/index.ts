// The lyric data shapes, in the one place both halves of braccato can agree on them.
//
// `@braccato/parsers` produces these and `@braccato/core` renders them, so a field added on one side
// and not the other is a silent mismatch across a package boundary. They were declared twice before
// this package existed, and they had already drifted: the renderer's copy carried `translations` and
// `explicit`, the parsers' copy did not.
//
// Nothing here emits runtime code. `@braccato/core` ships no runtime dependencies, and a type-only
// import is erased at compile time, so depending on this package costs a consumer's bundle nothing.

// -- Lyric data --------------------------------------------

export interface LyricPart {
	startTimeMs: number;
	words: string;
	durationMs: number;
	isBackground?: boolean;
	explicit?: boolean;
}

export interface Lyric {
	startTimeMs: number;
	words: string;
	durationMs: number;
	key?: string;
	parts?: LyricPart[];
	agent?: string;
	translations?: { [lang: string]: string };
	translation?: { text: string; lang: string }; // old property
	romanization?: string;
	timedRomanization?: LyricPart[];
	isInstrumental?: boolean;
}

// Not SyncType, which `@braccato/parsers` published first for the same union and goes on exporting as
// an alias of this. The longer name is the one `@braccato/core` uses, and it is the one that reads
// unambiguously beside a provider's sync quality ("syllable" | "word" | "line" | "unsynced"), which
// is a different axis measured in the same vocabulary.
export type LyricSyncType = "richsync" | "synced" | "none";

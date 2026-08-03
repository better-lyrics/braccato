import type { Lyric, LyricSyncType } from "@braccato/types";

// The lyric shapes live in `@braccato/types`, the one owner of them across the packages that produce
// and render lyrics. This package re-exports them so consumers go on importing `Lyric` and
// `LyricPart` from here, exactly as they always have.
export type { Lyric, LyricPart } from "@braccato/types";

// Published by this package first, under the shorter name. Same union as `LyricSyncType`, kept as an
// alias so existing imports resolve.
export type SyncType = LyricSyncType;

// The parser contract belongs to this package, so it stays declared here.
export interface LyricParser {
	parse(input: string, duration?: number): Lyric[];
	detect(input: string): boolean;
}

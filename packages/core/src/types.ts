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

export interface PartData {
	time: number;
	duration: number;
	element: HTMLElement;
	animationStartTimeMs: number;
}

export interface LineData {
	parts: PartData[];
	isScrolled: boolean;
	isAnimationPlayStatePlaying: boolean;
	accumulatedOffsetMs: number;
	isAnimating: boolean;
	lastAnimSetupAt: number;
	isSelected: boolean;
	height: number;
	position: number;
	time: number;
	duration: number;
	element: HTMLElement;
	animationStartTimeMs: number;
}

export interface LyricsData {
	lines: LineData[];
	syncType: SyncType;
	width: number;
	height: number;
	container: HTMLElement;
}

export interface BraccatoEventMap {
	"braccato:line-click": CustomEvent<{ time: number; lineIndex: number }>;
	"braccato:word-click": CustomEvent<{ time: number; lineIndex: number; wordIndex: number }>;
	"braccato:lyrics-loaded": CustomEvent<{ syncType: SyncType; lineCount: number }>;
	"braccato:scroll-state": CustomEvent<{ userScrolling: boolean }>;
	"braccato:error": CustomEvent<{ error: Error }>;
}

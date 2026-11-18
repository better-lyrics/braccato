// Types for js/renderer.js: `@braccato/core`'s renderer interface over the Rust renderer.
import type { Lyric, LyricPart, LyricSyncType } from "@braccato/types";
import type { Renderer } from "../pkg/braccato_core_rs.js";

export type { Lyric, LyricPart, LyricSyncType };

/** What `load` and `loadSync` take: an address, a response, bytes, or a compiled module. */
export type WasmSource = string | URL | Request | Response | BufferSource | WebAssembly.Module;

/** Loads the wasm. Resolves once renderers can be created; later calls return the same promise. */
export function load(source?: WasmSource): Promise<void>;
/** Loads the wasm from bytes or a compiled module, without waiting. */
export function loadSync(module: BufferSource | WebAssembly.Module): void;
/** Whether `createLyricsRenderer` can be called. */
export function isLoaded(): boolean;

/** Forgets the last player snapshot, as a new song should. */
export function resetPlaybackClock(): void;
/** Resumes autoscroll in every view a reader scrolled away in. */
export function resumeAllAutoscroll(): void;
/**
 * A 2D copy of what the renderer drawing on `canvas` shows now, styled like it, or null when no
 * renderer here draws on it. A WebGL canvas clones blank, so a host cloning the page uses this.
 */
export function snapshotCanvas(canvas: HTMLCanvasElement): HTMLCanvasElement | null;
/** The canvas the renderer that built `container` draws on, or null. */
export function canvasFor(container: HTMLElement): HTMLCanvasElement | null;
/** Whether `lyricElement` is a line one of this module's renderers built. */
export function ownsLine(lyricElement: Element): boolean;

export function injectTranslation(
	doc: Document,
	lyricElement: HTMLElement,
	text: string,
	language?: string | null,
): void;
export function injectRomanization(
	doc: Document,
	lyricElement: HTMLElement,
	lineData: unknown,
	text: string,
	timedRomanization?: LyricPart[] | null,
): void;
export function removeTranslation(lyricElement: HTMLElement): boolean;
export function removeRomanization(lyricElement: HTMLElement, lineData?: unknown): boolean;

export interface TickOptions {
	/** `Date.now()` when the time was read off the player; -1 (the default) when it was not. */
	eventCreationTime?: number;
	isPlaying: boolean;
	smoothScroll?: boolean;
	globalLyricOffset?: number;
	lyricOffset?: number;
	richsyncOffsetTrim?: number;
	lineOffsetTrim?: number;
	passiveScrollEnabled?: boolean;
	playbackRate?: number;
	/** Accepted for `@braccato/core` compatibility; the Rust renderer always follows paused seeks. */
	followPausedSeeks?: boolean;
	/** Accepted for `@braccato/core` compatibility. */
	countEveryUserScroll?: boolean;
}

export type AnimationTickStatus = "ok" | "lyrics-missing";

export interface StageBox {
	x: number;
	y: number;
	width: number;
	height: number;
}

export interface LyricsRendererHost {
	isViewVisible(): boolean;
	isLoaderActive(): boolean;
	syncAdState(): boolean;
	getScrollElement(): HTMLElement | null;
	setResumeAffordanceVisible(visible: boolean): void;
	seek(timeS: number): void;
	log(...args: unknown[]): void;
	onStageLayout?(box: StageBox | null): void;
	/** Accepted for `@braccato/core` compatibility; nothing is drawn to it. */
	debug?: unknown;
}

export type LyricsLayout = "scroll" | "stage";

export interface LyricsRendererOptions {
	document: Document;
	window: Window;
	mount?: HTMLElement;
	host?: Partial<LyricsRendererHost>;
	layout?: LyricsLayout;
}

export interface SetLyricsOptions {
	language?: string | null;
	loaderVisible?: boolean;
	noLyrics?: boolean;
	songwriters?: readonly string[];
	/** Lyrics given with the key of the song on screen are swapped into it. */
	songKey?: string;
	mount?: HTMLElement;
}

/** A word of a line. `time` and `duration` are in seconds; writing `time` moves the word. */
export interface PartData {
	lyricElement: HTMLElement;
	time: number;
	readonly duration: number;
	animations: Animation[];
}

/** A line the renderer built. `time` and `duration` are in seconds; writing `time` moves the line. */
export interface LineData {
	lyricElement: HTMLElement;
	time: number;
	readonly duration: number;
	parts: PartData[];
	isScrolled: boolean;
	isAnimationPlayStatePlaying: boolean;
	accumulatedOffsetMs: number;
	isAnimating: boolean;
	lastAnimSetupAt: number;
	isSelected: boolean;
	height: number;
	position: number;
	decorations: Map<HTMLElement, number>;
	animations: Animation[];
}

export interface LyricsRenderer {
	setLyrics(lyrics: Lyric[], options?: SetLyricsOptions): void;
	setLanguage(language?: string | null): void;
	/** Always false: the Rust renderer keeps the lyrics and rebuilds them itself. */
	setTheme(css: string): boolean;
	tick(currentTimeS: number, options: TickOptions): AnimationTickStatus;
	relayout(measureLines?: boolean): void;
	clear(): void;
	destroy(): void;
	noteUserScroll(): void;
	noteVisibilityChange(): void;
	resumeAutoscroll(): void;
	clearOnScreenLyrics(): boolean;
	scheduleLyricPositionUpdate(isTicking: () => boolean, retick: () => void): void;
	retickFromPlaybackClock(
		buildOptions: (eventCreationTime: number, isPlaying: boolean) => TickOptions,
	): AnimationTickStatus;
	readonly container: HTMLElement | null;
	readonly lines: readonly LineData[];
	readonly syncType: LyricSyncType;
	/** The Rust renderer underneath, for `setProfiling()`, `stats()` and `takeProfile()`; null before the first `setLyrics`. */
	readonly renderer: Renderer | null;
}

/** A lyrics view with `@braccato/core`'s interface, drawn by the Rust renderer. `load()` first. */
export function createLyricsRenderer(options: LyricsRendererOptions): LyricsRenderer;

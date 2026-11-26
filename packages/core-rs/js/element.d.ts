// Types for js/element.js: `@braccato/core/element`, the `<braccato-lyrics>` custom element.
import type { Lyric, LyricSyncType } from "@braccato/types";
import type { Renderer } from "../pkg/braccato_core_rs.js";
import type { LyricsLayout, SetLyricsOptions, StageBox, WasmSource } from "./renderer.js";

export { load } from "./renderer.js";
export type { Lyric, LyricsLayout, StageBox, WasmSource };

/** What the next `lyrics` write reads. */
export type LyricsElementOptions = Pick<SetLyricsOptions, "noLyrics" | "language" | "songwriters" | "songKey">;

/** What the element passes to the renderer's clock. Offsets and trims are in seconds. */
export interface LyricsElementTickOptions {
	lyricOffset?: number;
	globalLyricOffset?: number;
	/** Taken off the theme's `--blyrics-richsync-timing-offset` lead (see `Renderer.timingOffsets()`). */
	richsyncOffsetTrim?: number;
	/** Taken off the theme's `--blyrics-timing-offset` lead. */
	lineOffsetTrim?: number;
	playbackRate?: number;
	smoothScroll?: boolean;
	passiveScrollEnabled?: boolean;
}

/** Where autoscroll moves. Without it, the nearest scrollable element, the element itself included. */
export interface LyricsElementHost {
	getScrollElement?(): HTMLElement | null;
}

export interface LyricsElementDecorations {
	translations: boolean;
	romanizations: boolean;
}

export interface LyricsLoadedDetail {
	lineCount: number;
	syncType: LyricSyncType;
}

export interface LineClickDetail {
	/** The player time the click seeks to, in seconds, to the microsecond. */
	timeS: number;
}

export interface ScrollStateDetail {
	userScrolling: boolean;
}

export interface StageLayoutDetail {
	box: StageBox | null;
}

export interface LyricsErrorDetail {
	phase: "connect" | "lyrics" | "source";
	error: unknown;
}

export interface LyricsElementEventMap extends HTMLElementEventMap {
	"braccato:lyrics-loaded": CustomEvent<LyricsLoadedDetail>;
	"braccato:line-click": CustomEvent<LineClickDetail>;
	"braccato:scroll-state": CustomEvent<ScrollStateDetail>;
	"braccato:stage-layout": CustomEvent<StageLayoutDetail>;
	"braccato:error": CustomEvent<LyricsErrorDetail>;
}

export class BraccatoLyricsElement extends HTMLElement {
	static observedAttributes: string[];
	/** The song. An empty array clears the view. */
	lyrics: Lyric[] | null;
	lyricsOptions: LyricsElementOptions;
	/** A media element, or a selector for one, that drives the clock. */
	source: HTMLMediaElement | string | null;
	/** The media element `source` resolved to, once the renderer exists. */
	readonly mediaElement: HTMLMediaElement | null;
	/** Playback position in seconds, for hosts that drive the clock themselves. */
	currentTime: number;
	playing: boolean;
	tickOptions: LyricsElementTickOptions;
	/** A stylesheet of `--blyrics-*` properties and `blyrics-*` comment settings. */
	theme: string;
	host: LyricsElementHost;
	layout: LyricsLayout;
	decorations: LyricsElementDecorations;
	/** The Rust renderer, once the element is connected and the wasm has loaded. */
	readonly renderer: Renderer | null;
	readonly status: "idle" | "rendering";
	resumeAutoscroll(): void;
	relayout(): void;
	connectedCallback(): void;
	disconnectedCallback(): void;
	attributeChangedCallback(name: string, old: string | null, value: string | null): void;

	addEventListener<K extends keyof LyricsElementEventMap>(
		type: K,
		listener: (this: BraccatoLyricsElement, event: LyricsElementEventMap[K]) => unknown,
		options?: boolean | AddEventListenerOptions,
	): void;
	addEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | AddEventListenerOptions,
	): void;
	removeEventListener<K extends keyof LyricsElementEventMap>(
		type: K,
		listener: (this: BraccatoLyricsElement, event: LyricsElementEventMap[K]) => unknown,
		options?: boolean | EventListenerOptions,
	): void;
	removeEventListener(
		type: string,
		listener: EventListenerOrEventListenerObject,
		options?: boolean | EventListenerOptions,
	): void;
}

/** Defines the element under `tag` (default `braccato-lyrics`) unless something already holds it. */
export function defineLyricsElement(tag?: string): typeof BraccatoLyricsElement;

declare global {
	interface HTMLElementTagNameMap {
		"braccato-lyrics": BraccatoLyricsElement;
	}
}

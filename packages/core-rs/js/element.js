// The custom element around the Rust renderer. It only forwards: every property is handed to the
// renderer, which owns the DOM, the canvas and the clock. Properties written before the element
// connects (or before the wasm has loaded) are kept and applied once the renderer exists.

import { Renderer } from "../pkg/braccato_core_rs.js";
import { load } from "./renderer.js";

export { load };

const OBSERVED = ["source", "theme", "current-time", "playing", "layout"];

export class BraccatoLyricsElement extends HTMLElement {
	static observedAttributes = OBSERVED;

	#renderer = null;
	#lyrics = null;
	#lyricsOptions = {};
	#source = null;
	#media = null;
	#currentTime = 0;
	#playing = false;
	#tickOptions = {};
	#theme = "";
	#host = {};
	#decorations = { translations: true, romanizations: true };
	#layout = "scroll";
	#connecting = null;

	connectedCallback() {
		// A disconnect, or a later connect, while the wasm loads makes this connect stale.
		const generation = Symbol();
		this.#connecting = generation;
		load().then(
			() => {
				if (this.#connecting !== generation || !this.isConnected || this.#renderer) return;
				try {
					this.#renderer = new Renderer(this);
				} catch (error) {
					this.#emitError("connect", error);
					return;
				}
				this.#applyAll();
			},
			(error) => this.#emitError("connect", error),
		);
	}

	disconnectedCallback() {
		this.#connecting = null;
		this.#renderer?.destroy();
		this.#renderer?.free();
		this.#renderer = null;
	}

	attributeChangedCallback(name, _old, value) {
		switch (name) {
			case "source":
				this.source = value;
				break;
			case "theme":
				this.theme = value ?? "";
				break;
			case "current-time": {
				const seconds = Number.parseFloat(value ?? "");
				if (Number.isFinite(seconds)) this.currentTime = seconds;
				break;
			}
			case "playing":
				this.playing = value !== null;
				break;
			case "layout":
				this.layout = value;
				break;
		}
	}

	#applyAll() {
		const renderer = this.#renderer;
		renderer.setLayout(this.#layout);
		renderer.setScrollElement(this.#host.getScrollElement?.() ?? null);
		renderer.setTheme(this.#theme);
		renderer.setTickOptions(this.#tickOptions);
		renderer.setDecorations(this.#decorations.translations, this.#decorations.romanizations);
		this.#bindSource();
		renderer.setTime(this.#currentTime, this.#playing);
		if (this.#lyrics !== null) this.#applyLyrics();
	}

	#applyLyrics() {
		try {
			this.#renderer?.setLyrics(this.#lyrics, this.#lyricsOptions);
		} catch (error) {
			this.#emitError("lyrics", error);
		}
	}

	#bindSource() {
		// The element's own document and window: in an iframe or a Picture-in-Picture window, a
		// selector names that document's player, and its media elements are that window's class.
		const view = this.ownerDocument.defaultView;
		const isMedia = (node) => view !== null && node instanceof view.HTMLMediaElement;
		let media = null;
		if (typeof this.#source === "string") {
			media = this.isConnected ? this.ownerDocument.querySelector(this.#source) : null;
			if (this.#source && !media) this.#emitError("source", new Error(`No element matches ${this.#source}`));
		} else if (isMedia(this.#source)) {
			media = this.#source;
		}
		this.#media = isMedia(media) ? media : null;
		this.#renderer?.setMedia(this.#media);
	}

	#emitError(phase, error) {
		queueMicrotask(() =>
			this.dispatchEvent(
				new CustomEvent("braccato:error", { bubbles: true, composed: true, detail: { phase, error } }),
			),
		);
	}

	/** The song: a `Lyric[]`. An empty array clears the view. */
	get lyrics() {
		return this.#lyrics;
	}
	set lyrics(value) {
		this.#lyrics = value;
		this.#applyLyrics();
	}

	/** `{ noLyrics?, language?, songwriters? }`, read by the next `lyrics` write. */
	get lyricsOptions() {
		return this.#lyricsOptions;
	}
	set lyricsOptions(value) {
		this.#lyricsOptions = value ?? {};
	}

	/** A media element, or a selector for one, that drives the clock. */
	get source() {
		return this.#source;
	}
	set source(value) {
		this.#source = value ?? null;
		this.#bindSource();
	}

	get mediaElement() {
		return this.#renderer ? this.#media : null;
	}

	/** Playback position in seconds, for hosts that drive the clock themselves. */
	get currentTime() {
		return this.#currentTime;
	}
	set currentTime(value) {
		this.#currentTime = Number(value) || 0;
		this.#renderer?.setTime(this.#currentTime, this.#playing);
	}

	get playing() {
		return this.#playing;
	}
	set playing(value) {
		this.#playing = Boolean(value);
		this.#renderer?.setTime(this.#currentTime, this.#playing);
	}

	/** `{ lyricOffset?, globalLyricOffset?, playbackRate?, smoothScroll? }`. */
	get tickOptions() {
		return this.#tickOptions;
	}
	set tickOptions(value) {
		this.#tickOptions = value ?? {};
		this.#renderer?.setTickOptions(this.#tickOptions);
	}

	/** A stylesheet of `--blyrics-*` properties and `blyrics-*` comment settings. */
	get theme() {
		return this.#theme;
	}
	set theme(value) {
		this.#theme = String(value ?? "");
		this.#renderer?.setTheme(this.#theme);
	}

	/** `{ getScrollElement? }`: which element autoscroll moves. */
	get host() {
		return this.#host;
	}
	set host(value) {
		this.#host = value ?? {};
		this.#renderer?.setScrollElement(this.#host.getScrollElement?.() ?? null);
	}

	/** `"stage"` shows only the lines being sung, bottom-anchored; anything else scrolls. */
	get layout() {
		return this.#layout;
	}
	set layout(value) {
		this.#layout = value === "stage" ? "stage" : "scroll";
		this.#renderer?.setLayout(this.#layout);
	}

	/** Which of the lyrics' own translations and romanizations to show. */
	get decorations() {
		return { ...this.#decorations };
	}
	set decorations(value) {
		this.#decorations = { translations: Boolean(value?.translations), romanizations: Boolean(value?.romanizations) };
		this.#renderer?.setDecorations(this.#decorations.translations, this.#decorations.romanizations);
	}

	get renderer() {
		return this.#renderer;
	}

	get status() {
		return this.#renderer ? "rendering" : "idle";
	}

	resumeAutoscroll() {
		this.#renderer?.resumeAutoscroll();
	}

	relayout() {
		this.#renderer?.relayout();
	}
}

/** Defines the element under `tag` (default `braccato-lyrics`) unless something already holds it. */
export function defineLyricsElement(tag = "braccato-lyrics") {
	if (!customElements.get(tag)) customElements.define(tag, class extends BraccatoLyricsElement {});
	return customElements.get(tag);
}

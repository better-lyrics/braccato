import { detectParser } from "@braccato/parsers";
import { LitElement, html, unsafeCSS } from "lit";
import { property } from "lit/decorators.js";
import { type AnimEngineState, createAnimEngineState, resetAnimEngine, tick } from "./animation-engine.js";
import { type RenderOptions, renderLyrics } from "./renderer.js";
import { handleUserScroll, isUserScrolling, resumeAutoscroll } from "./scroll.js";
import type { BraccatoEventMap, Lyric, LyricsData, SyncType } from "./types.js";

// @ts-ignore
import lyricsCSS from "./styles/lyrics.css?inline";
// @ts-ignore - CSS imports handled by build
import variablesCSS from "./styles/variables.css?inline";

// @property must be registered globally — they don't work inside Shadow DOM stylesheets
function registerCSSProperties() {
	if (typeof CSS === "undefined" || !CSS.registerProperty) return;
	try {
		CSS.registerProperty({
			name: "--lyric-transition-amount-start",
			syntax: "<number>",
			inherits: false,
			initialValue: "0",
		});
		CSS.registerProperty({
			name: "--lyric-transition-amount-end",
			syntax: "<number>",
			inherits: false,
			initialValue: "0",
		});
	} catch {
		// Already registered
	}
}
registerCSSProperties();

export class BraccatoElement extends LitElement {
	static override styles = [unsafeCSS(variablesCSS), unsafeCSS(lyricsCSS)];

	// -- Properties --------------------------

	@property({ type: Array })
	lyrics: Lyric[] = [];

	@property({ attribute: "current-time", type: Number })
	currentTime = 0;

	@property({ type: Boolean, reflect: true })
	playing = false;

	@property({ attribute: "scroll-mode", type: String, reflect: true })
	scrollMode: "internal" | "external" = "internal";

	@property({ attribute: false })
	scrollContainer: HTMLElement | null = null;

	@property({ type: String, reflect: true })
	override dir: "auto" | "ltr" | "rtl" = "auto";

	// -- Render Options --------------------------

	@property({ attribute: "long-word-threshold", type: Number })
	longWordThreshold = 1500;

	@property({ attribute: "line-synced-delay", type: Number })
	lineSyncedDelay = 50;

	@property({ attribute: "disable-richsync", type: Boolean })
	disableRichsync = false;

	@property({ type: Boolean })
	debug = false;

	// -- Source Binding --------------------------

	@property({ type: String, reflect: true })
	source: string | null = null;

	@property({ type: String, reflect: true })
	src: string | null = null;

	// -- Callbacks --------------------------

	onLineActive?: (line: Lyric, index: number) => void;
	onLineInactive?: (line: Lyric, index: number) => void;

	// -- Internal State --------------------------

	private _lyricsData: LyricsData | null = null;
	private _animState: AnimEngineState = createAnimEngineState();
	private _rafId: number | null = null;
	private _lastLyrics: Lyric[] = [];
	private _resizeObserver: ResizeObserver | null = null;
	private _mediaElement: HTMLMediaElement | null = null;
	private _lastSrc: string | null = null;
	private _srcAbortController: AbortController | null = null;

	// -- Lifecycle --------------------------

	override connectedCallback(): void {
		super.connectedCallback();
		this._startLoop();
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._stopLoop();
		this._resizeObserver?.disconnect();
	}

	override updated(changed: Map<string, unknown>): void {
		if (changed.has("lyrics") && this.lyrics !== this._lastLyrics) {
			this._lastLyrics = this.lyrics;
			this._injectLyrics();
		}
		if (changed.has("source")) {
			this._resolveMediaElement();
		}
		if (changed.has("src") && this.src !== this._lastSrc) {
			this._lastSrc = this.src;
			this._fetchLyricsFromSrc();
		}
	}

	override render() {
		return html`<div class="braccato-container" part="container"></div>`;
	}

	// -- Lyric Injection --------------------------

	private _log(...args: unknown[]): void {
		if (this.debug) console.log("[braccato]", ...args);
	}

	private _injectLyrics(): void {
		const container = this.shadowRoot?.querySelector(".braccato-container") as HTMLElement;
		if (!container) {
			this._log("_injectLyrics: no container found in shadowRoot");
			return;
		}

		resetAnimEngine(this._animState);

		if (!this.lyrics || this.lyrics.length === 0) {
			this._log("_injectLyrics: no lyrics, clearing");
			container.replaceChildren();
			this._lyricsData = null;
			return;
		}

		const options: RenderOptions = {
			longWordThreshold: this.longWordThreshold,
			lineSyncedAnimationDelay: this.lineSyncedDelay,
			disableRichsync: this.disableRichsync,
		};

		this._lyricsData = renderLyrics(this.lyrics, container, options);

		this._log("_injectLyrics: rendered", {
			lineCount: this._lyricsData.lines.length,
			syncType: this._lyricsData.syncType,
			firstLineTime: this._lyricsData.lines[0]?.time,
			lastLineTime: this._lyricsData.lines[this._lyricsData.lines.length - 1]?.time,
			containerSize: { w: container.clientWidth, h: container.clientHeight },
		});

		// Click handlers
		for (let i = 0; i < this._lyricsData.lines.length; i++) {
			const line = this._lyricsData.lines[i];
			line.element.addEventListener("click", (e: MouseEvent) => this._handleLineClick(e, i));
		}

		// Scroll handler
		const scrollContainer = this._getScrollContainer();
		this._log("_injectLyrics: scrollContainer", scrollContainer.tagName, scrollContainer.className);
		scrollContainer.addEventListener("scroll", this._onScroll, { passive: true });

		// Resize observer
		this._resizeObserver?.disconnect();
		this._resizeObserver = new ResizeObserver(() => this._recalculatePositions());
		this._resizeObserver.observe(container);

		this._recalculatePositions();

		this.dispatchEvent(
			new CustomEvent("braccato:lyrics-loaded", {
				detail: { syncType: this._lyricsData.syncType, lineCount: this._lyricsData.lines.length },
				bubbles: true,
				composed: true,
			}),
		);
	}

	// -- Position Calculation --------------------------

	private _recalculatePositions(): void {
		if (!this._lyricsData) return;
		const container = this._lyricsData.container;
		this._lyricsData.width = container.clientWidth;
		this._lyricsData.height = container.clientHeight;

		for (const line of this._lyricsData.lines) {
			const rect = line.element.getBoundingClientRect();
			const containerRect = container.getBoundingClientRect();
			line.position = rect.top - containerRect.top + container.scrollTop;
			line.height = rect.height;
		}
		this._animState.scroll.wasUserScrolling = true;
	}

	// -- Animation Loop --------------------------

	private _startLoop(): void {
		const loop = () => {
			this._tick();
			this._rafId = requestAnimationFrame(loop);
		};
		this._rafId = requestAnimationFrame(loop);
	}

	private _stopLoop(): void {
		if (this._rafId !== null) {
			cancelAnimationFrame(this._rafId);
			this._rafId = null;
		}
	}

	private _tickCount = 0;

	private _tick(): void {
		if (!this._lyricsData || this._lyricsData.syncType === "none") return;

		this._tickCount++;
		if (this.debug && this._tickCount % 60 === 0) {
			const activeLines = this._lyricsData.lines.filter((l) => l.isScrolled);
			const animatingLines = this._lyricsData.lines.filter((l) => l.isAnimating);
			this._log("tick", {
				currentTime: this.currentTime,
				currentTimeSec: this.currentTime / 1000,
				playing: this.playing,
				syncType: this._lyricsData.syncType,
				activeLineCount: activeLines.length,
				animatingLineCount: animatingLines.length,
				selectedIndex: this._animState.selectedElementIndex,
				scrollResumeTime: this._animState.scroll.scrollResumeTime,
				isUserScrolling: this._animState.scroll.wasUserScrolling,
			});
		}

		const media = this._mediaElement;
		const currentTimeMs = media ? media.currentTime * 1000 : this.currentTime;
		const isPlaying = media ? !media.paused : this.playing;

		tick(this._animState, {
			currentTime: currentTimeMs / 1000,
			eventCreationTime: Date.now(),
			isPlaying,
			smoothScroll: true,
			lyricsData: this._lyricsData,
			scrollContainer: this._getScrollContainer(),
		});
	}

	// -- Scroll --------------------------

	private _getScrollContainer(): HTMLElement {
		if (this.scrollMode === "external" && this.scrollContainer) {
			return this.scrollContainer;
		}
		return this;
	}

	private _onScroll = (): void => {
		const ss = this._animState.scroll;
		if (ss.skipScrolls > 0) {
			ss.skipScrolls--;
			return;
		}

		if (!isUserScrolling(ss)) {
			handleUserScroll(ss);
			this.dispatchEvent(
				new CustomEvent("braccato:scroll-state", {
					detail: { userScrolling: true },
					bubbles: true,
					composed: true,
				}),
			);
		} else {
			handleUserScroll(ss);
		}
	};

	// -- Events --------------------------

	private _handleLineClick(e: MouseEvent, lineIndex: number): void {
		const line = this._lyricsData?.lines[lineIndex];
		if (!line) return;

		const time = line.time * 1000;
		this._log("lineClick", { lineIndex, time, lineTimeSec: line.time, currentTime: this.currentTime });

		if (e.altKey && this._lyricsData?.syncType === "richsync") {
			const wordEl = (e.target as HTMLElement).closest(".braccato--word") as HTMLElement | null;
			if (wordEl) {
				const wordTime = Number.parseFloat(wordEl.dataset.time || "0") * 1000;
				const wordIndex = line.parts.findIndex((p) => p.element === wordEl);
				this.dispatchEvent(
					new CustomEvent("braccato:word-click", {
						detail: { time: wordTime, lineIndex, wordIndex },
						bubbles: true,
						composed: true,
					}),
				);
				return;
			}
		}

		if (this._mediaElement) {
			this._mediaElement.currentTime = time / 1000;
			if (this._mediaElement.paused) this._mediaElement.play();
		}

		this.dispatchEvent(
			new CustomEvent("braccato:line-click", {
				detail: { time, lineIndex },
				bubbles: true,
				composed: true,
			}),
		);

		resumeAutoscroll(this._animState.scroll);
	}

	// -- Source Binding --------------------------

	private _resolveMediaElement(): void {
		if (!this.source) {
			this._mediaElement = null;
			return;
		}
		const el = document.querySelector(this.source);
		if (el instanceof HTMLMediaElement) {
			this._mediaElement = el;
		} else {
			this._mediaElement = null;
			this._log("source: no media element found for selector", this.source);
		}
	}

	private async _fetchLyricsFromSrc(): Promise<void> {
		this._srcAbortController?.abort();

		if (!this.src) {
			this.lyrics = [];
			return;
		}

		const controller = new AbortController();
		this._srcAbortController = controller;

		try {
			const res = await fetch(this.src, { signal: controller.signal });
			if (!res.ok) {
				this._emitError(new Error(`Failed to fetch lyrics: ${res.status} ${res.statusText}`));
				return;
			}

			const text = await res.text();
			if (controller.signal.aborted) return;

			const durationMs = this._mediaElement ? this._mediaElement.duration * 1000 : 300000;
			const parser = detectParser(text);
			this.lyrics = parser.parse(text, durationMs);
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			this._emitError(e instanceof Error ? e : new Error(String(e)));
		}
	}

	private _emitError(error: Error): void {
		this._log("error", error.message);
		this.dispatchEvent(
			new CustomEvent("braccato:error", {
				detail: { error },
				bubbles: true,
				composed: true,
			}),
		);
	}

	// -- Public Methods --------------------------

	resumeAutoscroll(): void {
		resumeAutoscroll(this._animState.scroll);
	}

	recalculatePositions(): void {
		this._recalculatePositions();
	}
}

declare global {
	interface HTMLElementTagNameMap {
		"braccato-lyrics": BraccatoElement;
	}
	interface HTMLElementEventMap extends BraccatoEventMap {}
}

customElements.define("braccato-lyrics", BraccatoElement);

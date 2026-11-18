// `createLyricsRenderer` over the Rust renderer, with the shape `@braccato/core` gives it, so a
// consumer written against core can switch renderers without changing how it drives one.
//
// What differs underneath: the renderer draws on its own animation frames, so `tick` only hands it
// the player snapshot (time, play state and when it was read) and frames in between carry the time
// forward; the lines it hands out (`lines`) are records over the Rust song, whose `time` writes go
// back to it; and decorations are hung on a line by this module's `injectTranslation` and
// `injectRomanization` rather than written into its element.

import init, { initSync, Renderer } from "../pkg/braccato_core_rs.js";

// -- Loading --------------------------------------------

let ready = null;
let loaded = false;

/**
 * Loads the wasm. `source` is anything wasm-bindgen's loader takes: a URL (by default the file next
 * to this module), a `Response`, bytes or a compiled `WebAssembly.Module`. Resolves once renderers can
 * be created; later calls return the same promise.
 */
export function load(source) {
	ready ??= init(source === undefined ? undefined : { module_or_path: source }).then(() => {
		loaded = true;
	});
	return ready;
}

/** Loads the wasm from bytes or a compiled module without waiting. */
export function loadSync(module) {
	if (!loaded) {
		initSync({ module });
		loaded = true;
		ready ??= Promise.resolve();
	}
}

/** Whether `createLyricsRenderer` can be called. */
export function isLoaded() {
	return loaded;
}

// -- Module-wide state --------------------------------------------

/** Every renderer not yet destroyed. */
const live = new Set();

/** The last player snapshot any renderer here was ticked with, as core keeps it. */
const NO_SNAPSHOT = -1;
const snapshot = { timeS: 0, isPlaying: false, eventCreationTime: NO_SNAPSHOT };

/** Forgets the last player snapshot, as a new song should. */
export function resetPlaybackClock() {
	snapshot.timeS = 0;
	snapshot.isPlaying = false;
	snapshot.eventCreationTime = NO_SNAPSHOT;
	for (const view of live) view.resetClock();
}

/** Resumes autoscroll in every view a reader scrolled away in. */
export function resumeAllAutoscroll() {
	for (const view of live) view.resumeAutoscroll();
}

function owner(lyricElement) {
	for (const view of live) {
		const index = view.indexOf(lyricElement);
		if (index >= 0) return { view, index };
	}
	return null;
}

/**
 * A 2D copy of what the renderer drawing on `canvas` shows now, styled like it, or null when no
 * renderer here draws on it. For a host that clones the page to animate it away: a WebGL canvas
 * clones blank.
 */
export function snapshotCanvas(canvas) {
	for (const view of live) {
		if (view.canvas() === canvas) return view.snapshot();
	}
	return null;
}

/** The canvas the renderer that built `container` draws on, or null. */
export function canvasFor(container) {
	for (const view of live) {
		if (view.container() === container) return view.canvas();
	}
	return null;
}

/** Whether `lyricElement` is a line one of this module's renderers built. */
export function ownsLine(lyricElement) {
	return owner(lyricElement) !== null;
}

// -- Decorations --------------------------------------------

function normalizeLanguage(language) {
	if (!language || language === "auto" || language === "und") return "";
	try {
		return Intl.getCanonicalLocales(language.trim().replaceAll("_", "-"))[0] ?? "";
	} catch {
		return "";
	}
}

/** Hangs a translation on a line. A translation that only repeats the line is not shown. */
export function injectTranslation(_doc, lyricElement, text, language) {
	owner(lyricElement)?.view.hangTranslation(lyricElement, text, normalizeLanguage(language));
}

/** Hangs a romanization on a line, swept by `timedRomanization` when it has timed parts. */
export function injectRomanization(_doc, lyricElement, _lineData, text, timedRomanization = null) {
	owner(lyricElement)?.view.hangRomanization(lyricElement, text, timedRomanization);
}

/** Takes a line's translation off. Answers whether it had one. */
export function removeTranslation(lyricElement) {
	return owner(lyricElement)?.view.hangTranslation(lyricElement, null) ?? false;
}

/** Takes a line's romanization off. Answers whether it had one. */
export function removeRomanization(lyricElement, _lineData) {
	return owner(lyricElement)?.view.hangRomanization(lyricElement, null) ?? false;
}

// -- Line records --------------------------------------------

// Core's `LineData` and `PartData` are its live render state. Here they are views of the Rust song:
// `time` and `duration` read it, and writing `time` moves the line or part. The other fields exist
// so code that sets them keeps working, and mean nothing to this renderer.

class PartRecord {
	#view;
	#line;
	#index;
	lyricElement;
	animations = [];

	constructor(view, line, index, element) {
		this.#view = view;
		this.#line = line;
		this.#index = index;
		this.lyricElement = element;
	}

	get time() {
		return this.#view.timing(this.#line.lyricElement, this.#index)[0];
	}
	set time(value) {
		this.#view.setStart(this.#line.lyricElement, this.#index, value);
	}
	get duration() {
		return this.#view.timing(this.#line.lyricElement, this.#index)[1];
	}
}

class LineRecord {
	#view;
	lyricElement;
	parts = [];
	isScrolled = false;
	isAnimationPlayStatePlaying = false;
	accumulatedOffsetMs = 0;
	isAnimating = false;
	lastAnimSetupAt = 0;
	isSelected = false;
	height = -1;
	position = -1;
	decorations = new Map();
	animations = [];

	constructor(view, element) {
		this.#view = view;
		this.lyricElement = element;
	}

	setParts(elements) {
		const same =
			elements.length === this.parts.length && elements.every((element, i) => element === this.parts[i].lyricElement);
		if (!same) this.parts = elements.map((element, i) => new PartRecord(this.#view, this, i, element));
	}

	get time() {
		return this.#view.timing(this.lyricElement)[0];
	}
	set time(value) {
		this.#view.setStart(this.lyricElement, undefined, value);
	}
	get duration() {
		return this.#view.timing(this.lyricElement)[1];
	}
}

// -- The renderer --------------------------------------------

const SEEK_EVENT = "braccato:seek";
const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll"]);

function noop() {}

function findScrollElement(win, mount) {
	for (let element = mount; element; element = element.parentElement) {
		if (SCROLLABLE_OVERFLOW.has(win.getComputedStyle(element).overflowY)) return element;
	}
	return mount?.ownerDocument.scrollingElement ?? null;
}

function resolveTickOptions(options) {
	return {
		eventCreationTime: options.eventCreationTime ?? NO_SNAPSHOT,
		isPlaying: Boolean(options.isPlaying),
		smoothScroll: options.smoothScroll ?? true,
		globalLyricOffset: options.globalLyricOffset ?? 0,
		lyricOffset: options.lyricOffset ?? 0,
		richsyncOffsetTrim: options.richsyncOffsetTrim ?? 0,
		lineOffsetTrim: options.lineOffsetTrim ?? 0,
		passiveScrollEnabled: options.passiveScrollEnabled ?? false,
		playbackRate: options.playbackRate ?? 1,
	};
}

/**
 * A lyrics view with `@braccato/core`'s `LyricsRenderer` interface, drawn by the Rust renderer.
 * `load()` must have resolved first.
 */
export function createLyricsRenderer(rendererOptions) {
	if (!loaded) throw new Error("@braccato/core-rs: call load() before createLyricsRenderer()");
	const doc = rendererOptions.document;
	const win = rendererOptions.window;
	const layout = rendererOptions.layout ?? "scroll";
	const given = rendererOptions.host ?? {};
	let mount = rendererOptions.mount ?? null;
	let rust = null;
	let attached = false;
	let destroyed = false;
	let listening = null;
	let scrollElement;
	let tickKey = "";
	let records = [];
	let recordsGeneration = -1;
	let pendingPosition = null;
	let lastCss = null;

	let walkedMount;
	let walkedScrollElement = null;
	const host = {
		isViewVisible: given.isViewVisible ?? (() => true),
		isLoaderActive: given.isLoaderActive ?? (() => false),
		syncAdState: given.syncAdState ?? (() => false),
		getScrollElement:
			given.getScrollElement ??
			(() => {
				if (mount !== walkedMount) {
					walkedMount = mount;
					walkedScrollElement = findScrollElement(win, mount);
				}
				return walkedScrollElement;
			}),
		setResumeAffordanceVisible: given.setResumeAffordanceVisible ?? noop,
		seek:
			given.seek ??
			((timeS) => mount?.dispatchEvent(new win.CustomEvent(SEEK_EVENT, { detail: timeS, bubbles: true }))),
		log: given.log ?? noop,
		onStageLayout: given.onStageLayout,
	};

	const onEvent = (event) => {
		const detail = event.detail ?? {};
		switch (event.type) {
			case "braccato:line-click":
				host.seek(detail.timeS);
				break;
			case "braccato:scroll-state":
				host.setResumeAffordanceVisible(Boolean(detail.userScrolling));
				break;
			case "braccato:stage-layout":
				host.onStageLayout?.(detail.box ?? null);
				break;
		}
	};
	const EVENTS = ["braccato:line-click", "braccato:scroll-state", "braccato:stage-layout"];

	function listenOn(element) {
		if (listening === element) return;
		for (const name of EVENTS) listening?.removeEventListener(name, onEvent);
		listening = element;
		for (const name of EVENTS) element.addEventListener(name, onEvent);
	}

	function syncScrollElement() {
		const element = host.getScrollElement() ?? null;
		if (element !== scrollElement) {
			scrollElement = element;
			rust.setScrollElement(element);
		}
	}

	function ensure(nextMount) {
		if (rust && nextMount.ownerDocument !== doc) {
			throw new Error("@braccato/core-rs: a renderer stays in the document it was created for");
		}
		if (!rust) {
			rust = new Renderer(nextMount);
			rust.setLayout(layout);
			rust.setDecorations(false, false);
			// Core leaves telling a reader's scroll apart to the host, through noteUserScroll.
			rust.setScrollDetection(false);
			if (lastCss !== null) rust.setTheme(lastCss);
			scrollElement = undefined;
		} else if (nextMount !== mount || !attached) {
			rust.setHost(nextMount);
		}
		mount = nextMount;
		attached = true;
		listenOn(nextMount);
		syncScrollElement();
	}

	function syncRecords() {
		if (!rust || !attached) {
			records = [];
			recordsGeneration = -1;
			return records;
		}
		const generation = rust.generation;
		if (generation === recordsGeneration) return records;
		recordsGeneration = generation;
		const byElement = new Map(records.map((record) => [record.lyricElement, record]));
		records = rust.lineElements().map(({ element, parts }) => {
			const record = byElement.get(element) ?? new LineRecord(view, element);
			record.setParts(parts);
			return record;
		});
		Object.freeze(records);
		return records;
	}

	function indexOf(lyricElement) {
		return rust && attached ? rust.lineIndex(lyricElement) : -1;
	}

	// What the records and the module-level helpers reach this renderer through.
	const view = {
		indexOf,
		timing(lyricElement, part) {
			const index = indexOf(lyricElement);
			return (index >= 0 && rust.timing(index, part)) || [0, 0];
		},
		setStart(lyricElement, part, value) {
			const index = indexOf(lyricElement);
			if (index >= 0 && Number.isFinite(value)) rust.setStart(index, part, value);
		},
		hangTranslation(lyricElement, text, language) {
			const index = indexOf(lyricElement);
			return index >= 0 ? rust.hangTranslation(index, text ?? undefined, language ?? undefined) : false;
		},
		hangRomanization(lyricElement, text, timed) {
			const index = indexOf(lyricElement);
			return index >= 0 ? rust.hangRomanization(index, text ?? undefined, timed ?? null) : false;
		},
		resetClock() {
			rust?.resetClock();
		},
		canvas() {
			return rust?.canvas ?? null;
		},
		container() {
			return rust && attached ? rust.container : null;
		},
		snapshot() {
			return rust?.snapshot() ?? null;
		},
		resumeAutoscroll() {
			rust?.resumeAutoscroll();
		},
	};
	live.add(view);

	function tick(currentTimeS, options) {
		if (destroyed) return "lyrics-missing";
		const resolved = resolveTickOptions(options ?? {});
		snapshot.timeS = currentTimeS;
		snapshot.isPlaying = resolved.isPlaying;
		snapshot.eventCreationTime = resolved.eventCreationTime;
		if (currentTimeS === 0 && !resolved.isPlaying) return "ok";
		if (!host.isViewVisible() || host.syncAdState()) {
			rust?.setHidden(true);
			return "ok";
		}
		if (!rust || !attached || !rust.hasSong()) {
			host.log("No lyrics have been built for this view to render");
			return "lyrics-missing";
		}
		rust.setHidden(false);
		syncScrollElement();
		const key = JSON.stringify([
			resolved.smoothScroll,
			resolved.globalLyricOffset,
			resolved.lyricOffset,
			resolved.richsyncOffsetTrim,
			resolved.lineOffsetTrim,
			resolved.passiveScrollEnabled,
			resolved.playbackRate,
		]);
		if (key !== tickKey) {
			tickKey = key;
			rust.setTickOptions(resolved);
		}
		rust.setSnapshot(currentTimeS, resolved.isPlaying, resolved.eventCreationTime);
		return "ok";
	}

	return {
		setLyrics(lyrics, options = {}) {
			if (destroyed) {
				host.log("Lyrics were handed to a renderer that has been destroyed; nothing was built");
				return;
			}
			const nextMount = options.mount ?? mount;
			if (!nextMount) {
				throw new Error("A lyrics renderer needs a mount: give one to createLyricsRenderer or to setLyrics");
			}
			ensure(nextMount);
			rust.setLyrics(lyrics, {
				noLyrics: options.noLyrics ?? false,
				language: normalizeLanguage(options.language) || undefined,
				songwriters: options.songwriters ? [...options.songwriters] : undefined,
				songKey: options.songKey,
			});
			rust.container.dataset.loaderVisible = String(options.loaderVisible ?? false);
		},
		setLanguage(language) {
			if (!destroyed) rust?.setLanguage(normalizeLanguage(language));
		},
		setTheme(css) {
			if (destroyed) return false;
			lastCss = css;
			rust?.setTheme(css);
			// The Rust renderer keeps the lyrics and rebuilds them itself.
			return false;
		},
		tick,
		relayout() {
			if (!destroyed) rust?.relayout(false);
		},
		clear() {
			if (destroyed || !rust) return;
			rust.clear();
			attached = false;
			syncRecords();
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			live.delete(view);
			for (const name of EVENTS) listening?.removeEventListener(name, onEvent);
			if (pendingPosition !== null) win.cancelAnimationFrame(pendingPosition.frame);
			rust?.destroy();
			rust?.free();
			rust = null;
			records = [];
		},
		noteUserScroll() {
			// As core: a scroll while the host shows its loader (a new source on its way) is not a reader's.
			if (destroyed || host.isLoaderActive()) return;
			rust?.noteScroll();
		},
		noteVisibilityChange() {},
		resumeAutoscroll() {
			if (!destroyed) rust?.resumeAutoscroll();
		},
		clearOnScreenLyrics() {
			if (destroyed || !rust || !attached) return false;
			const had = rust.clearOnScreen();
			syncRecords();
			return had;
		},
		scheduleLyricPositionUpdate(isTicking, retick) {
			if (destroyed) return;
			if (pendingPosition !== null) {
				pendingPosition.isTicking = isTicking;
				pendingPosition.retick = retick;
				return;
			}
			pendingPosition = { isTicking, retick, frame: 0 };
			pendingPosition.frame = win.requestAnimationFrame(() => {
				const { isTicking: ticking, retick: after } = pendingPosition;
				pendingPosition = null;
				if (destroyed || !ticking()) return;
				rust?.relayout(true);
				after();
			});
		},
		retickFromPlaybackClock(buildOptions) {
			if (destroyed) return "lyrics-missing";
			const options = buildOptions(snapshot.eventCreationTime, snapshot.isPlaying);
			return tick(snapshot.timeS, options);
		},
		get container() {
			return rust && attached ? rust.container : null;
		},
		get lines() {
			return syncRecords();
		},
		get syncType() {
			return rust && attached ? rust.syncType() : "none";
		},
		/** The Rust renderer underneath, for `setProfiling()`, `stats()` and `takeProfile()`; null before the first `setLyrics`. */
		get renderer() {
			return rust;
		},
	};
}

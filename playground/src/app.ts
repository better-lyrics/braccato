import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { resumeAllAutoscroll } from "@braccato/core";
import type { BraccatoLyricsElement } from "@braccato/core/element";
import { detectParser } from "@braccato/parsers";
import {
	ProviderChain,
	createBLyricsProvider,
	createLRCLibSyncedProvider,
	createLRCLibPlainProvider,
	createLegatoProvider,
} from "@braccato/provider-blyrics";

const braccato = document.getElementById("lyrics") as BraccatoLyricsElement;
const audio = document.getElementById("audio") as HTMLAudioElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const scrubber = document.getElementById("scrubber") as HTMLInputElement;
const timeDisplay = document.getElementById("time-display") as HTMLSpanElement;
const audioInput = document.getElementById("audio-input") as HTMLInputElement;
const lyricsInput = document.getElementById("lyrics-input") as HTMLInputElement;
const audioDrop = document.getElementById("audio-drop") as HTMLLabelElement;
const lyricsDrop = document.getElementById("lyrics-drop") as HTMLLabelElement;
const syncBadge = document.getElementById("sync-badge") as HTMLDivElement;
const eventLog = document.getElementById("event-log") as HTMLDivElement;
const cssEditor = document.getElementById("css-editor") as HTMLTextAreaElement;
const installCmd = document.getElementById("install-cmd") as HTMLElement;
const searchSong = document.getElementById("search-song") as HTMLInputElement;
const searchArtist = document.getElementById("search-artist") as HTMLInputElement;
const searchAlbum = document.getElementById("search-album") as HTMLInputElement;
const searchDuration = document.getElementById("search-duration") as HTMLInputElement;
const searchBtn = document.getElementById("search-btn") as HTMLButtonElement;
const searchResult = document.getElementById("search-result") as HTMLDivElement;
const audioUrl = document.getElementById("audio-url") as HTMLInputElement;
let isManualScrubbing = false;
let currentLyricsText = "";
let debugLogging = false;

const defaultCustomCSS = `.blyrics-container {\n\t--blyrics-font-family: "Satoshi", system-ui, sans-serif;\n\t--blyrics-font-weight: 500;\n}`;

// The engine has no debug flag of its own; the host decides where diagnostics go and whether they
// go anywhere. Written once, because writing host while connected rebuilds the view.
braccato.host = {
	log: (...args: unknown[]) => {
		if (debugLogging) console.log("[braccato]", ...args);
	},
};

// Autoscroll pauses when a reader scrolls away, and the element does not watch for that itself.
braccato.addEventListener("scroll", () => braccato.renderer?.noteUserScroll(), { passive: true });

function setDropLabel(label: HTMLLabelElement, iconClass: string, text: string) {
	for (const node of [...label.childNodes]) {
		if (node.nodeType !== Node.ELEMENT_NODE || !(node as HTMLElement).matches("input")) {
			node.remove();
		}
	}
	const icon = document.createElement("i");
	icon.className = iconClass;
	label.prepend(icon, ` ${text}`);
}

// -- Install Copy --------------------------

installCmd.addEventListener("click", async () => {
	await navigator.clipboard.writeText("npm i @braccato/core");
	const icon = installCmd.querySelector("i")!;
	const origClass = icon.className;
	icon.className = "mgc_check_line";
	setTimeout(() => {
		icon.className = origClass;
	}, 1500);
});

// -- Audio Controls --------------------------

playBtn.addEventListener("click", togglePlay);

function togglePlay() {
	if (audio.paused) audio.play();
	else audio.pause();
}

function setPlayIcon(icon: string) {
	playBtn.replaceChildren();
	const i = document.createElement("i");
	i.className = icon;
	playBtn.appendChild(i);
}

audio.addEventListener("play", () => {
	setPlayIcon("mgc_pause_fill");
	braccato.playing = true;
});

audio.addEventListener("pause", () => {
	setPlayIcon("mgc_play_fill");
	braccato.playing = false;
});

scrubber.addEventListener("input", () => {
	isManualScrubbing = true;
	const t = Number(scrubber.value);
	braccato.currentTime = t / 1000;
	updateTimeDisplay(t / 1000, audio.duration || 0);
	updateScrubberFill();
});

scrubber.addEventListener("change", () => {
	audio.currentTime = Number(scrubber.value) / 1000;
	isManualScrubbing = false;
});

function fmt(s: number): string {
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

function updateTimeDisplay(current: number, total: number) {
	timeDisplay.textContent = `${fmt(current)} / ${fmt(total)}`;
}

function updateScrubberFill() {
	const pct = (Number(scrubber.value) / Number(scrubber.max)) * 100;
	scrubber.style.background = `linear-gradient(to right, var(--accent) ${pct}%, #27272a ${pct}%)`;
}

function animLoop() {
	if (!isManualScrubbing && !audio.paused) {
		braccato.currentTime = audio.currentTime;
		scrubber.value = String(audio.currentTime * 1000);
		updateTimeDisplay(audio.currentTime, audio.duration || 0);
		updateScrubberFill();
	}
	requestAnimationFrame(animLoop);
}

requestAnimationFrame(animLoop);

// -- File Loading --------------------------

audioInput.addEventListener("change", () => {
	const file = audioInput.files?.[0];
	if (file) loadAudio(file);
});

lyricsInput.addEventListener("change", () => {
	const file = lyricsInput.files?.[0];
	if (file) loadLyrics(file);
});

function setupDrop(zone: HTMLElement, handler: (file: File) => void) {
	zone.addEventListener("dragover", (e) => {
		e.preventDefault();
		zone.classList.add("dragover");
	});
	zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
	zone.addEventListener("drop", (e) => {
		e.preventDefault();
		zone.classList.remove("dragover");
		const file = (e as DragEvent).dataTransfer?.files[0];
		if (file) handler(file);
	});
}

setupDrop(audioDrop, loadAudio);
setupDrop(lyricsDrop, loadLyrics);

function loadAudio(file: File) {
	audio.src = URL.createObjectURL(file);
	audio.addEventListener(
		"loadedmetadata",
		() => {
			scrubber.max = String(audio.duration * 1000);
			reparseIfNeeded();
		},
		{ once: true },
	);
	setDropLabel(audioDrop, "mgc_music_2_line", file.name);
	audioDrop.classList.add("loaded");
}

async function loadLyrics(file: File) {
	const text = await file.text();
	currentLyricsText = text;
	parseLyrics(text);
	setDropLabel(lyricsDrop, "mgc_text_line", file.name);
	lyricsDrop.classList.add("loaded");
}

function parseLyrics(text: string) {
	const parser = detectParser(text);
	const duration = audio.duration ? audio.duration * 1000 : 300000;
	braccato.lyrics = parser.parse(text, duration);
}

function reparseIfNeeded() {
	if (currentLyricsText) parseLyrics(currentLyricsText);
}

// -- Events --------------------------

function logEvent(name: string, detail: Record<string, unknown>) {
	const entry = document.createElement("div");
	entry.className = "entry";

	const ts = document.createElement("span");
	ts.className = "ts";
	ts.textContent = audio.currentTime ? fmt(audio.currentTime) : "0:00";

	const ev = document.createElement("span");
	ev.className = "ev";
	ev.textContent = name;

	entry.append(ts, " ", ev, ` ${JSON.stringify(detail)}`);
	eventLog.prepend(entry);
	while (eventLog.children.length > 50) eventLog.lastChild?.remove();
}

braccato.addEventListener("braccato:line-click", ((e: CustomEvent) => {
	audio.currentTime = e.detail.timeS;
	braccato.currentTime = e.detail.timeS;
	resumeAllAutoscroll();
	if (audio.paused) audio.play();
	logEvent("line-click", e.detail);
}) as EventListener);

// There is no braccato:word-click any more. The DOM is light and the class names are published, so
// a word seek is a click listener, and it runs after the line handler on the child element.
braccato.addEventListener("click", (e) => {
	if (!e.altKey) return;
	const word = (e.target as HTMLElement).closest(".blyrics--word") as HTMLElement | null;
	if (!word) return;
	const timeS = Number(word.dataset.time);
	if (!Number.isFinite(timeS)) return;
	audio.currentTime = timeS;
	braccato.currentTime = timeS;
	logEvent("word-click", { timeS, words: word.dataset.content });
});

braccato.addEventListener("braccato:lyrics-loaded", ((e: CustomEvent) => {
	logEvent("lyrics-loaded", e.detail);
	syncBadge.textContent = e.detail.syncType;
	syncBadge.dataset.sync = e.detail.syncType;
}) as EventListener);

braccato.addEventListener("braccato:scroll-state", ((e: CustomEvent) => {
	logEvent("scroll-state", e.detail);
}) as EventListener);

// -- Theme --------------------------

// What used to be three attributes is three settings the engine reads out of the stylesheet's
// comments, so the property controls and the CSS editor now write the same thing.
const themeSettings: Record<string, string> = {
	"blyrics-disable-richsync": "false",
	"blyrics-line-synced-animation-delay": "50",
	"blyrics-long-word-threshold": "1500",
};

function applyTheme() {
	const declarations = Object.entries(themeSettings)
		.map(([key, value]) => `/* ${key} = ${value}; */`)
		.join("\n");
	braccato.theme = `${declarations}\n${cssEditor.value}`;
}

document.getElementById("disable-richsync")!.addEventListener("change", (e) => {
	themeSettings["blyrics-disable-richsync"] = String((e.target as HTMLInputElement).checked);
	applyTheme();
});

const lineSyncedDelay = document.getElementById("line-synced-delay") as HTMLInputElement;
const lineSyncedDelayVal = document.getElementById("line-synced-delay-val") as HTMLSpanElement;
lineSyncedDelay.addEventListener("input", () => {
	themeSettings["blyrics-line-synced-animation-delay"] = lineSyncedDelay.value;
	lineSyncedDelayVal.textContent = lineSyncedDelay.value;
	applyTheme();
});

const longWord = document.getElementById("long-word-threshold") as HTMLInputElement;
const longWordVal = document.getElementById("long-word-threshold-val") as HTMLSpanElement;
longWord.addEventListener("input", () => {
	themeSettings["blyrics-long-word-threshold"] = longWord.value;
	longWordVal.textContent = longWord.value;
	applyTheme();
});

cssEditor.value = defaultCustomCSS;
applyTheme();

cssEditor.addEventListener("input", applyTheme);

cssEditor.addEventListener("keydown", (e) => {
	if (e.key === "Tab") {
		e.preventDefault();
		const start = cssEditor.selectionStart;
		const end = cssEditor.selectionEnd;
		cssEditor.value = `${cssEditor.value.substring(0, start)}\t${cssEditor.value.substring(end)}`;
		cssEditor.selectionStart = cssEditor.selectionEnd = start + 1;
		applyTheme();
	}
});

// -- Keyboard Shortcuts --------------------------

document.addEventListener("keydown", (e) => {
	const tag = (e.target as HTMLElement).tagName;
	if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;

	switch (e.code) {
		case "Space":
			e.preventDefault();
			togglePlay();
			break;
		case "ArrowLeft":
			e.preventDefault();
			audio.currentTime = Math.max(0, audio.currentTime - (e.shiftKey ? 1 : 5));
			braccato.currentTime = audio.currentTime;
			break;
		case "ArrowRight":
			e.preventDefault();
			audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + (e.shiftKey ? 1 : 5));
			braccato.currentTime = audio.currentTime;
			break;
		case "KeyR":
			resumeAllAutoscroll();
			break;
		case "KeyD":
			debugLogging = !debugLogging;
			logEvent("debug", { enabled: debugLogging });
			break;
	}
});

// -- Provider Chain --------------------------

const chain = new ProviderChain();
chain.register({ key: "blyrics", displayName: "bLyrics", syncType: "syllable", fetch: createBLyricsProvider() });
chain.register({ key: "legato", displayName: "Legato", syncType: "word", fetch: createLegatoProvider() });
chain.register({ key: "lrclib-synced", displayName: "LRCLib", syncType: "line", fetch: createLRCLibSyncedProvider() });
chain.register({ key: "lrclib-plain", displayName: "LRCLib", syncType: "unsynced", fetch: createLRCLibPlainProvider() });

let searchAbort: AbortController | null = null;

async function performSearch() {
	const song = searchSong.value.trim();
	const artist = searchArtist.value.trim();
	if (!song) return;

	searchAbort?.abort();
	searchAbort = new AbortController();

	searchBtn.disabled = true;
	searchResult.textContent = "Searching...";
	chain.clearCache();

	const manualDuration = Number(searchDuration.value);
	const duration =
		manualDuration > 0 ? manualDuration : audio.duration && Number.isFinite(audio.duration) ? audio.duration : 300;
	const album = searchAlbum.value.trim() || null;

	let matchedKey = "";

	try {
		const result = await chain.fetchLyrics(
			{ song, artist, duration, album, signal: searchAbort.signal },
			{
				onProviderResult: (key, r) => {
					if (r?.lyrics && r.lyrics.length > 0) matchedKey = key;
				},
				onProviderError: (key, err) => {
					logEvent("provider-error", { key, message: err.message });
				},
			},
		);

		if (result?.lyrics && result.lyrics.length > 0) {
			currentLyricsText = "";
			braccato.lyrics = result.lyrics;
			const reg = chain.getRegistered().find((r) => r.key === matchedKey);
			const syncLabel = reg?.syncType ?? "none";
			searchResult.textContent = "";
			const srcSpan = document.createElement("span");
			srcSpan.textContent = result.source;
			const badge = document.createElement("span");
			badge.className = "badge";
			badge.textContent = syncLabel;
			searchResult.append(srcSpan, badge);
			logEvent("search", { source: result.source, syncType: syncLabel, lines: result.lyrics.length });
		} else {
			searchResult.textContent = "No lyrics found";
		}
	} catch {
		if (!searchAbort.signal.aborted) {
			searchResult.textContent = "Search failed";
		}
	} finally {
		searchBtn.disabled = false;
	}
}

searchBtn.addEventListener("click", performSearch);

for (const input of [searchSong, searchArtist, searchAlbum, searchDuration]) {
	input.addEventListener("keydown", (e) => {
		if (e.key === "Enter") performSearch();
	});
}

audio.addEventListener("loadedmetadata", () => {
	if (!searchDuration.value) {
		searchDuration.placeholder = `duration in seconds (${Math.round(audio.duration)})`;
	}
});

// -- Audio URL --------------------------

audioUrl.addEventListener("keydown", (e) => {
	if (e.key !== "Enter") return;
	const url = audioUrl.value.trim();
	if (!url) return;

	audio.src = url;
	audio.addEventListener(
		"loadedmetadata",
		() => {
			scrubber.max = String(audio.duration * 1000);
			reparseIfNeeded();
		},
		{ once: true },
	);

	let label: string;
	try {
		label = new URL(url).hostname;
	} catch {
		label = "audio URL";
	}
	setDropLabel(audioDrop, "mgc_music_2_line", label);
	audioDrop.classList.add("loaded");
});

// -- Load Demo --------------------------

async function loadDemo() {
	try {
		const [ttmlRes, mp3Res] = await Promise.all([fetch("/demo.ttml"), fetch("/demo.mp3")]);

		if (ttmlRes.ok) {
			currentLyricsText = await ttmlRes.text();
			parseLyrics(currentLyricsText);
			setDropLabel(lyricsDrop, "mgc_text_line", "demo.ttml");
			lyricsDrop.classList.add("loaded");
		}

		if (mp3Res.ok) {
			audio.src = URL.createObjectURL(await mp3Res.blob());
			audio.addEventListener(
				"loadedmetadata",
				() => {
					scrubber.max = String(audio.duration * 1000);
					reparseIfNeeded();
				},
				{ once: true },
			);
			setDropLabel(audioDrop, "mgc_music_2_line", "demo.mp3");
			audioDrop.classList.add("loaded");
		}
	} catch {
		// No demo files
	}
}

loadDemo();

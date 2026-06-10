import { createInstrumentalElement } from "./create-instrumental-element.js";
import { testRtl } from "./rtl.js";
import { splitPart } from "./split-part.js";
import type { LineData, Lyric, LyricPart, LyricsData, PartData, SyncType } from "./types.js";

// -- CSS Class Constants --------------------------

const LINE_CLASS = "braccato--line";
const WORD_CLASS = "braccato--word";
const BREAK_CLASS = "braccato--break";
const BG_CLASS = "braccato-background-lyric";
const RTL_CLASS = "braccato-rtl";
const ZERO_DUR_CLASS = "braccato-zero-dur-animate";
const ROMANIZED_CLASS = "braccato--romanized";
const TRANSLATED_CLASS = "braccato--translated";

const BREAK_CHAR_RE = /[\s​­\p{Dash_Punctuation}]/u;

// -- Helpers --------------------------

function findNearestAgent(lyrics: Lyric[], fromIndex: number): string | undefined {
	for (let i = fromIndex - 1; i >= 0; i--) {
		if (!lyrics[i].isInstrumental && lyrics[i].agent) return lyrics[i].agent;
	}
	for (let i = fromIndex + 1; i < lyrics.length; i++) {
		if (!lyrics[i].isInstrumental && lyrics[i].agent) return lyrics[i].agent;
	}
	return undefined;
}

function isNearestLyricRtl(lyrics: Lyric[], fromIndex: number): boolean {
	for (let i = fromIndex - 1; i >= 0; i--) {
		if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) return testRtl(lyrics[i].words);
	}
	for (let i = fromIndex + 1; i < lyrics.length; i++) {
		if (!lyrics[i].isInstrumental && lyrics[i].words?.trim()) return testRtl(lyrics[i].words);
	}
	return false;
}

function createBreakElem(parent: HTMLElement, order: number): void {
	const br = document.createElement("span");
	br.classList.add(BREAK_CLASS);
	br.style.order = String(order);
	parent.appendChild(br);
}

function groupByWordAndInsert(parent: HTMLElement, buffer: HTMLSpanElement[]): void {
	let wordGroupBuffer: HTMLSpanElement[] = [];
	let isCurrentBufferBg = false;

	const flush = () => {
		if (wordGroupBuffer.length > 0) {
			const span = document.createElement("span");
			for (const word of wordGroupBuffer) span.appendChild(word);
			if (isCurrentBufferBg) span.classList.add(BG_CLASS);
			parent.appendChild(span);
			wordGroupBuffer = [];
		}
	};

	for (const part of buffer) {
		const partIsBg = part.classList.contains(BG_CLASS);
		if (isCurrentBufferBg !== partIsBg) {
			flush();
			isCurrentBufferBg = partIsBg;
		}
		wordGroupBuffer.push(part);

		const text = part.textContent ?? "";
		const endsOnBreak = text.length > 0 && BREAK_CHAR_RE.test(text[text.length - 1]);
		const wrapAfter = part.dataset.wrapAfter === "true";
		if (endsOnBreak || wrapAfter) flush();
	}
	flush();
}

function buildWordSpans(parts: LyricPart[], line: LineData, container: HTMLElement, longWordThreshold: number): void {
	let rtlBuffer: HTMLSpanElement[] = [];
	let isAllRtl = true;
	const elemBuffer: HTMLSpanElement[] = [];

	for (const part of parts) {
		const isRtl = testRtl(part.words);
		if (!isRtl && part.words.trim().length > 0) {
			isAllRtl = false;
			rtlBuffer.reverse().forEach((el) => elemBuffer.push(el));
			rtlBuffer = [];
		}

		const subParts = splitPart(part);

		for (const sub of subParts) {
			const span = document.createElement("span");
			span.classList.add(WORD_CLASS);
			if (sub.durationMs === 0) span.classList.add(ZERO_DUR_CLASS);
			if (isRtl) span.classList.add(RTL_CLASS);

			const partData: PartData = {
				time: sub.startTimeMs / 1000,
				duration: sub.durationMs / 1000,
				element: span,
				animationStartTimeMs: Number.POSITIVE_INFINITY,
			};

			span.textContent = sub.words;
			span.dataset.time = String(partData.time);
			span.dataset.duration = String(partData.duration);
			span.dataset.content = sub.words;
			span.style.setProperty("--braccato-duration", `${sub.durationMs}ms`);
			if (sub.durationMs > longWordThreshold) span.dataset.longWord = "true";
			if (sub.isBackground) span.classList.add(BG_CLASS);
			if (sub.isWrapAfter) span.dataset.wrapAfter = "true";
			if (sub.words.trim().length === 0) span.style.display = "inline";
			if (sub.words.trim().length !== 0) line.parts.push(partData);

			if (isRtl) {
				rtlBuffer.push(span);
			} else {
				elemBuffer.push(span);
			}
		}
	}

	if (isAllRtl && rtlBuffer.length > 0) {
		container.classList.add(RTL_CLASS);
		for (const el of rtlBuffer) elemBuffer.push(el);
	} else if (rtlBuffer.length > 0) {
		rtlBuffer.reverse().forEach((el) => elemBuffer.push(el));
	}

	groupByWordAndInsert(container, elemBuffer);
}

// -- Public API --------------------------

export interface RenderOptions {
	longWordThreshold?: number;
	lineSyncedAnimationDelay?: number;
	disableRichsync?: boolean;
}

export function renderLyrics(lyrics: Lyric[], container: HTMLElement, options: RenderOptions = {}): LyricsData {
	const { longWordThreshold = 1500, lineSyncedAnimationDelay = 50, disableRichsync = false } = options;

	container.replaceChildren();
	const allZero = lyrics.every((l) => l.startTimeMs === 0);
	let syncType: SyncType = allZero ? "none" : "synced";
	const lines: LineData[] = [];

	for (let lineIndex = 0; lineIndex < lyrics.length; lineIndex++) {
		const item = lyrics[lineIndex];
		const el = item.isInstrumental
			? createInstrumentalElement(item.durationMs, lineIndex)
			: document.createElement("div");
		el.classList.add(LINE_CLASS);

		const line: LineData = {
			element: el,
			time: item.startTimeMs / 1000,
			duration: item.durationMs / 1000,
			parts: [],
			isScrolled: false,
			animationStartTimeMs: Number.POSITIVE_INFINITY,
			isAnimationPlayStatePlaying: false,
			accumulatedOffsetMs: 0,
			isAnimating: false,
			lastAnimSetupAt: 0,
			isSelected: false,
			height: -1,
			position: -1,
		};

		if (item.isInstrumental) {
			el.dataset.instrumental = "true";
			el.dataset.time = String(line.time);
			el.dataset.duration = String(line.duration);
			el.dataset.lineNumber = String(lineIndex);

			const nearestAgent = findNearestAgent(lyrics, lineIndex);
			if (nearestAgent) el.dataset.agent = nearestAgent;
			if (isNearestLyricRtl(lyrics, lineIndex)) el.classList.add(RTL_CLASS);

			lines.push(line);
			container.appendChild(el);
			continue;
		}

		let parts = item.parts ?? [];
		if (parts.length === 0 || disableRichsync) {
			parts = item.words.split(" ").map((word, index) => ({
				startTimeMs: item.startTimeMs + index * lineSyncedAnimationDelay,
				words: word.trim().length < 1 ? word : `${word} `,
				durationMs: 0,
			}));
		}

		if (!parts.every((p) => p.durationMs === 0)) syncType = "richsync";

		buildWordSpans(parts, line, el, longWordThreshold);
		createBreakElem(el, 1);

		el.dataset.time = String(line.time);
		el.dataset.duration = String(line.duration);
		el.dataset.lineNumber = String(lineIndex);
		el.style.setProperty("--braccato-duration", `${item.durationMs}ms`);
		if (item.agent) el.dataset.agent = item.agent;

		// Romanization
		if (item.romanization) {
			createBreakElem(el, 4);
			const romanEl = document.createElement("div");
			romanEl.classList.add(ROMANIZED_CLASS);
			romanEl.style.order = "5";
			if (item.timedRomanization && item.timedRomanization.length > 0 && !disableRichsync) {
				buildWordSpans(item.timedRomanization, line, romanEl, longWordThreshold);
			} else {
				romanEl.textContent = `\n${item.romanization}`;
			}
			el.appendChild(romanEl);
		}

		// Translation
		if (item.translation) {
			createBreakElem(el, 6);
			const transEl = document.createElement("div");
			transEl.classList.add(TRANSLATED_CLASS);
			transEl.style.order = "7";
			transEl.textContent = `\n${item.translation.text}`;
			el.appendChild(transEl);
		}

		lines.push(line);
		container.appendChild(el);
	}

	container.dataset.sync = syncType;

	// Spacing element at bottom
	const spacer = document.createElement("div");
	spacer.className = "braccato--spacer";
	spacer.style.height = "100px";
	container.appendChild(spacer);

	return {
		lines,
		syncType,
		width: container.clientWidth,
		height: container.clientHeight,
		container,
	};
}

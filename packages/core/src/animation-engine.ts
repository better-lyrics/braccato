import { type ScrollState, createScrollState, decaySkipScrolls, resetScrollState } from "./scroll.js";
import type { LineData, LyricsData, PartData } from "./types.js";

// -- Constants --------------------------

const ANIMATING_CLASS = "braccato--animating";
const PRE_ANIMATING_CLASS = "braccato--pre-animating";
const PAUSED_CLASS = "braccato--paused";
const CURRENT_CLASS = "braccato--active";
const USER_SCROLLING_CLASS = "braccato--user-scrolling";

const TIME_JUMP_THRESHOLD = 0.5;
const DEFAULT_ENDING_THRESHOLD = 0.5;
const DEFAULT_EARLY_SCROLL_CONSIDER = 0.62;
const DEFAULT_SCROLL_POS_RATIO = 0.37;
const DEFAULT_QUEUE_SCROLL_MS = 150;

// -- CSS Duration Caching --------------------------

const cachedDurations = new Map<string, number>();

function toMs(cssDuration: string): number {
	if (!cssDuration) return 0;
	if (cssDuration.endsWith("ms")) return Number.parseFloat(cssDuration.slice(0, -2));
	if (cssDuration.endsWith("s")) return Number.parseFloat(cssDuration.slice(0, -1)) * 1000;
	return 0;
}

function getCSSDurationInMs(el: HTMLElement, property: string): number {
	let val = cachedDurations.get(property);
	if (val === undefined) {
		val = toMs(getComputedStyle(el).getPropertyValue(property));
		cachedDurations.set(property, val);
	}
	return val;
}

function reflow(el: HTMLElement): void {
	void el.offsetHeight;
}

// -- Engine State --------------------------

export interface AnimEngineState {
	scroll: ScrollState;
	selectedElementIndex: number;
	lastTime: number;
	lastPlayState: boolean;
	lastEventCreationTime: number;
	lastActiveElements: LineData[];
}

export function createAnimEngineState(): AnimEngineState {
	return {
		scroll: createScrollState(),
		selectedElementIndex: 0,
		lastTime: 0,
		lastPlayState: false,
		lastEventCreationTime: 0,
		lastActiveElements: [],
	};
}

export function resetAnimEngine(state: AnimEngineState): void {
	resetScrollState(state.scroll);
	state.lastActiveElements = [];
	cachedDurations.clear();
}

// -- Main Tick Function --------------------------

export interface TickOptions {
	currentTime: number;
	eventCreationTime: number;
	isPlaying: boolean;
	smoothScroll: boolean;
	lyricsData: LyricsData;
	scrollContainer: HTMLElement;
	scrollPosRatio?: number;
	endingThreshold?: number;
	earlyScrollConsider?: number;
	queueScrollMs?: number;
}

export function tick(state: AnimEngineState, opts: TickOptions): void {
	const now = Date.now();
	let { currentTime, isPlaying, smoothScroll } = opts;
	const {
		eventCreationTime,
		lyricsData,
		scrollContainer,
		scrollPosRatio = DEFAULT_SCROLL_POS_RATIO,
		endingThreshold = DEFAULT_ENDING_THRESHOLD,
		earlyScrollConsider = DEFAULT_EARLY_SCROLL_CONSIDER,
		queueScrollMs = DEFAULT_QUEUE_SCROLL_MS,
	} = opts;

	if (currentTime === 0 && !isPlaying) return;

	const timeJumped =
		Math.abs(currentTime - state.lastTime - (eventCreationTime - state.lastEventCreationTime) / 1000) >
		TIME_JUMP_THRESHOLD;

	state.lastTime = currentTime;
	state.lastPlayState = isPlaying;
	state.lastEventCreationTime = eventCreationTime;

	const timeOffset = isPlaying ? now - eventCreationTime : 0;
	currentTime += timeOffset / 1000;

	const { lines, container: lyricsElement, syncType } = lyricsData;

	if (syncType === "richsync") {
		currentTime += getCSSDurationInMs(lyricsElement, "--braccato-richsync-timing-offset") / 1000;
	} else {
		currentTime += getCSSDurationInMs(lyricsElement, "--braccato-timing-offset") / 1000;
	}

	const lyricScrollTime = currentTime + getCSSDurationInMs(lyricsElement, "--braccato-scroll-timing-offset") / 1000;

	const scrollHeight = scrollContainer.getBoundingClientRect().height;
	let scrollTop = scrollContainer.scrollTop;

	const activeElems: LineData[] = [];
	const linesToAnimate: LineData[] = [];
	let newLyricSelected = timeJumped;

	for (let index = 0; index < lines.length; index++) {
		const lineData = lines[index];
		const time = lineData.time;
		const nextTime = index + 1 < lines.length ? lines[index + 1].time : Number.POSITIVE_INFINITY;

		// -- Scroll highlighting --
		if (
			lyricScrollTime >= time - earlyScrollConsider &&
			(lyricScrollTime < nextTime || lyricScrollTime < time + lineData.duration)
		) {
			activeElems.push(lineData);
			if (!state.lastActiveElements.includes(lineData) && lyricScrollTime >= time) {
				newLyricSelected = true;
			}
			state.selectedElementIndex = index;
			if (!lineData.isScrolled) {
				lineData.element.classList.add(CURRENT_CLASS);
				lineData.isScrolled = true;
			}
		} else if (lineData.isScrolled) {
			lineData.element.classList.remove(CURRENT_CLASS);
			lineData.isScrolled = false;
		}

		// -- Animation setup --
		const setUpEarly = isPlaying ? 2 : 0;
		const effectiveEnd = Math.max(nextTime, time + lineData.duration + 0.05);

		if (currentTime + setUpEarly >= time && currentTime < effectiveEnd) {
			lineData.isSelected = true;

			const timeDelta = currentTime - time;
			const animOffset = (now - lineData.animationStartTimeMs) / 1000 - timeDelta;
			lineData.accumulatedOffsetMs = lineData.accumulatedOffsetMs / 1.08;
			lineData.accumulatedOffsetMs += animOffset * 1000 * 0.4;

			if (lineData.isAnimating && Math.abs(lineData.accumulatedOffsetMs) > 100 && isPlaying) {
				lineData.isAnimating = false;
			}

			if (isPlaying !== lineData.isAnimationPlayStatePlaying) {
				lineData.isAnimationPlayStatePlaying = isPlaying;
				const children: (LineData | PartData)[] = [lineData, ...lineData.parts];
				if (!isPlaying) {
					for (const part of children) {
						if (part.animationStartTimeMs > now) {
							part.element.classList.remove(ANIMATING_CLASS);
							part.element.classList.remove(PRE_ANIMATING_CLASS);
						} else {
							part.element.classList.add(PAUSED_CLASS);
						}
					}
				} else {
					for (const part of children) {
						part.element.classList.remove(PAUSED_CLASS);
					}
					lineData.isAnimating = false;
				}
			}

			if (!lineData.isAnimating) linesToAnimate.push(lineData);
		} else if (lineData.isSelected) {
			const children: (LineData | PartData)[] = [lineData, ...lineData.parts];
			for (const part of children) {
				part.element.style.setProperty("--braccato-swipe-delay", "");
				part.element.style.setProperty("--braccato-anim-delay", "");
				part.element.classList.remove(ANIMATING_CLASS);
				part.element.classList.remove(PRE_ANIMATING_CLASS);
				part.element.classList.remove(PAUSED_CLASS);
				part.animationStartTimeMs = Number.POSITIVE_INFINITY;
			}
			lineData.isSelected = false;
			lineData.isAnimating = false;
		}
	}

	// -- Batched animation setup --
	if (linesToAnimate.length > 0) {
		for (const lineData of linesToAnimate) {
			const children: (LineData | PartData)[] = [lineData, ...lineData.parts];
			for (const part of children) {
				const timeDelta = currentTime - part.time;
				part.element.classList.remove(ANIMATING_CLASS);
				part.element.classList.remove(PAUSED_CLASS);
				part.element.style.setProperty("--braccato-swipe-delay", `${-timeDelta - part.duration * 0.1}s`);
				part.element.style.setProperty("--braccato-anim-delay", `${-timeDelta}s`);
				part.element.classList.add(PRE_ANIMATING_CLASS);
			}
		}

		reflow(linesToAnimate[0].element);

		for (const lineData of linesToAnimate) {
			const children: (LineData | PartData)[] = [lineData, ...lineData.parts];
			for (const part of children) {
				const timeDelta = currentTime - part.time;
				part.element.classList.add(ANIMATING_CLASS);
				part.animationStartTimeMs = now - timeDelta * 1000;
			}
			lineData.isAnimating = true;
			lineData.lastAnimSetupAt = now;
			lineData.isAnimationPlayStatePlaying = true;
			lineData.accumulatedOffsetMs = 0;
		}
	}

	// -- Scrolling --
	const ss = state.scroll;
	if (ss.scrollResumeTime < now || ss.scrollPos === -1) {
		if (activeElems.length === 0) activeElems.push(lines[0]);

		state.lastActiveElements = activeElems.filter((e) => lyricScrollTime >= e.time);
		const scrollPosOffset = scrollHeight * scrollPosRatio;

		const lastActive = activeElems[activeElems.length - 1];
		const positions = activeElems
			.filter((ld, i) => lyricScrollTime < ld.time + ld.duration - endingThreshold || i === activeElems.length - 1)
			.map((ld) => ld.position + ld.height / 2);

		const avgPos = positions.reduce((a, b) => a + b, 0) / positions.length;

		let scrollPos = avgPos - scrollPosOffset;
		scrollPos = Math.min(scrollPos, activeElems[0].position);
		scrollPos = Math.max(scrollPos, lastActive.position - scrollHeight + lastActive.height);
		scrollPos = Math.min(scrollPos, lastActive.position);
		scrollPos = Math.max(0, scrollPos);

		if (scrollTop === 0 && !ss.doneFirstInstantScroll) {
			smoothScroll = false;
			ss.doneFirstInstantScroll = true;
			ss.nextScrollAllowedTime = 0;
		}

		if (ss.wasUserScrolling || newLyricSelected || ss.queuedScroll) {
			if (now > ss.nextScrollAllowedTime) {
				ss.queuedScroll = false;

				if (smoothScroll && Math.abs(scrollTop - scrollPos) > 2) {
					lyricsElement.style.transitionTimingFunction = "";
					lyricsElement.style.transitionProperty = "";
					lyricsElement.style.transitionDuration = "";

					const scrollTime = getCSSDurationInMs(lyricsElement, "transition-duration");

					lyricsElement.style.transition = "none";
					lyricsElement.style.transform = `translate(0px, ${-(scrollTop - scrollPos)}px)`;
					reflow(lyricsElement);
					lyricsElement.style.transition = "";
					lyricsElement.style.transform = "translate(0px, 0px)";

					ss.nextScrollAllowedTime = scrollTime + now + 20;
				}

				scrollTop = scrollPos;
				ss.scrollPos = scrollTop;
				scrollContainer.scrollTop = scrollTop;
				ss.skipScrolls += 1;
				ss.skipScrollsDecayTimes.push(now + 2000);
			} else if (ss.nextScrollAllowedTime - now < queueScrollMs || timeJumped) {
				ss.queuedScroll = true;
			}
		}
	}

	if (ss.wasUserScrolling && ss.scrollResumeTime < now) {
		lyricsElement.classList.remove(USER_SCROLLING_CLASS);
		ss.wasUserScrolling = false;
	}

	decaySkipScrolls(ss, now);
}

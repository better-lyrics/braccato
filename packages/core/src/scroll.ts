const SCROLL_PAUSE_DURATION = 25000;

export interface ScrollState {
	skipScrolls: number;
	skipScrollsDecayTimes: number[];
	scrollResumeTime: number;
	scrollPos: number;
	nextScrollAllowedTime: number;
	wasUserScrolling: boolean;
	doneFirstInstantScroll: boolean;
	queuedScroll: boolean;
}

export function createScrollState(): ScrollState {
	return {
		skipScrolls: 0,
		skipScrollsDecayTimes: [],
		scrollResumeTime: 0,
		scrollPos: 0,
		nextScrollAllowedTime: 0,
		wasUserScrolling: false,
		doneFirstInstantScroll: false,
		queuedScroll: false,
	};
}

export function resetScrollState(state: ScrollState): void {
	state.skipScrollsDecayTimes = [];
	state.doneFirstInstantScroll = false;
	state.queuedScroll = false;
}

export function handleUserScroll(state: ScrollState): void {
	state.wasUserScrolling = true;
	state.scrollResumeTime = Date.now() + SCROLL_PAUSE_DURATION;
}

export function resumeAutoscroll(state: ScrollState): void {
	state.scrollResumeTime = 0;
}

export function isUserScrolling(state: ScrollState): boolean {
	return state.scrollResumeTime > Date.now();
}

export function decaySkipScrolls(state: ScrollState, now: number): void {
	let j = 0;
	for (; j < state.skipScrollsDecayTimes.length; j++) {
		if (state.skipScrollsDecayTimes[j] > now) break;
	}
	state.skipScrollsDecayTimes = state.skipScrollsDecayTimes.slice(j);
	state.skipScrolls -= j;
	if (state.skipScrolls < 1) state.skipScrolls = 1;
}

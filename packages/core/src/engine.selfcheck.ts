import { strict as assert } from "node:assert";
import { CREDITS_CLASS, CREDITS_NAMES_CLASS, CREDITS_TEXT_CLASS, LINE_CLASS, USER_SCROLLING_CLASS } from "./constants";
import {
  type AnimationEngineInstance,
  clearLyrics,
  clearOnScreenLyrics,
  computeActiveLinesScrollTop,
  computeLetterSwipeWindows,
  computeScrollPadding,
  createAnimationEngineInstance,
  findScrollAnchor,
  forEveryLiveView,
  getRenderedLines,
  getRenderedSyncType,
  hasRenderedLines,
  noteUserScroll,
  parseColorAlpha,
  planLetterMaskSweep,
  planLetterWave,
  relayout,
  resolveScrollInsets,
  resolveTickOptions,
  scheduleLyricPositionUpdate,
  setupLineCullObserver,
  tickView,
} from "./engine";
import { asDocument, asElement, asFakeNode, collectTree, FakeDocument, type FakeNode } from "./selfcheck/fakeDom";
import {
  asWindow,
  FakeMediaQueryList,
  FakeWindow,
  installFakeDOMRect,
  poisonAmbientGlobals,
} from "./selfcheck/fakeWindow";
import { parseThemeConfig, setThemeSettings } from "./themeSettings";
import type { StageBox } from "./stage";
import type { Lyric, LyricsRendererHost, TickOptions } from "./types";
import { setLyrics } from "./view";

// Two instances, two documents, two windows, two hosts, and nothing shared between them. Only one
// instance exists in the extension today, so every field the engine holds per view is currently
// indistinguishable from a module level one: both spellings typecheck, both lint, and in a browser
// both animate the side panel correctly. The failure only shows up once the floating window opens a
// second view, and it shows up as that window rendering nothing while the panel looks fine.
//
// The ambient globals are poisoned for the same reason. `document.createElement` and
// `engine.document.createElement` both work in a browser, and the second view is the only thing
// that can tell them apart.

// -- Ambient global poison --------------------------------------------

const ambientGlobals = poisonAmbientGlobals(
  name => `The renderer read the ambient global ${name} instead of the one its instance was handed`
);

installFakeDOMRect();

// -- Measurements the host owns --------------------------------------------

const VIEWPORT_HEIGHT_PX = 400;
const LINE_HEIGHT_PX = 60;
const PLAYBACK_TIME_S = 0.2;

// -- Fake host --------------------------------------------

// The scroll container belongs to the host, not to the module, so the module never builds it. It
// still lives in the view's document, as it would in a browser. It answers only what the tick reads off it, and it clamps a `scrollTop` write the way a
// browser does: silently, which is what a module aiming past the end of its content relies on.
class FakeScrollElement {
  private currentScrollTop = 0;
  private readonly styleProperties: Record<string, string> = {};
  readonly style = {
    setProperty: (name: string, value: string): void => {
      this.styleProperties[name] = value;
    },
    getPropertyValue: (name: string): string => this.styleProperties[name] ?? "",
  };

  constructor(
    readonly viewportHeight: number,
    readonly scrollHeight = viewportHeight * 100,
    readonly ownerDocument: FakeDocument | null = null
  ) {}

  get clientHeight(): number {
    return this.viewportHeight;
  }

  get scrollTop(): number {
    return this.currentScrollTop;
  }

  set scrollTop(value: number) {
    this.currentScrollTop = Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight));
  }

  getBoundingClientRect(): { height: number } {
    return { height: this.viewportHeight };
  }
}

class FakeHost implements LyricsRendererHost {
  readonly resumeAffordanceCalls: boolean[] = [];
  readonly logs: unknown[][] = [];
  readonly scrollElement: FakeScrollElement;

  constructor(contentHeight?: number, ownerDocument: FakeDocument | null = null) {
    this.scrollElement = new FakeScrollElement(VIEWPORT_HEIGHT_PX, contentHeight, ownerDocument);
  }

  isViewVisible(): boolean {
    return true;
  }

  isLoaderActive(): boolean {
    return false;
  }

  syncAdState(): boolean {
    return false;
  }

  getScrollElement(): HTMLElement | null {
    return this.scrollElement as unknown as HTMLElement;
  }

  setResumeAffordanceVisible(visible: boolean): void {
    this.resumeAffordanceCalls.push(visible);
  }

  seek(): void {
    assert.fail("Nothing in this run clicks a line, so no view may ask its host to seek");
  }

  log(...args: unknown[]): void {
    this.logs.push(args);
  }
}

// -- Fixtures --------------------------------------------

// Far enough ahead of the playback time that no line is selected, so the tick reaches the style
// reads and the scroll maths without starting a single Web Animation.
const RICH_SYNCED_LYRICS: Lyric[] = [
  {
    startTimeMs: 100000,
    durationMs: 2000,
    words: "Hello world",
    parts: [
      { startTimeMs: 100000, words: "Hello ", durationMs: 900 },
      { startTimeMs: 100900, words: "world", durationMs: 1100 },
    ],
  },
  {
    startTimeMs: 102000,
    durationMs: 2000,
    words: "Second line",
    parts: [
      { startTimeMs: 102000, words: "Second ", durationMs: 800 },
      { startTimeMs: 102800, words: "line", durationMs: 1200 },
    ],
  },
];

const LINE_SYNCED_LYRICS: Lyric[] = [
  { startTimeMs: 200000, durationMs: 3000, words: "One" },
  { startTimeMs: 203000, durationMs: 3000, words: "Two" },
  { startTimeMs: 206000, durationMs: 3000, words: "Three" },
];

// Every line at time zero, which is what a provider with no timings gives and also what the
// "no lyrics" message looks like. Only the flag tells the two apart.
const UNSYNCED_LYRICS: Lyric[] = [
  { startTimeMs: 0, durationMs: 0, words: "One" },
  { startTimeMs: 0, durationMs: 0, words: "Two" },
  { startTimeMs: 0, durationMs: 0, words: "Three" },
];

const NO_LYRICS_PLACEHOLDER: Lyric[] = [{ startTimeMs: 0, durationMs: 0, words: "No lyrics found for this song" }];

// The same properties, answered differently by each document. The style caches are keyed by
// property name alone, so a cache shared between instances would hand one view the other's values.
const SCROLL_TIMING_OFFSET_PROPERTY = "--blyrics-scroll-timing-offset";
const SCROLL_EASING_PROPERTY = "--blyrics-lyric-scroll-timing-function";
const ANIMATE_SCROLL_PROPERTY = "--blyrics-animate-scroll";

const PANEL_STYLE: Record<string, string> = {
  [SCROLL_TIMING_OFFSET_PROPERTY]: "20ms",
  [SCROLL_EASING_PROPERTY]: "ease-in",
  [ANIMATE_SCROLL_PROPERTY]: "1",
};

const FLOATING_STYLE: Record<string, string> = {
  [SCROLL_TIMING_OFFSET_PROPERTY]: "-70ms",
  [SCROLL_EASING_PROPERTY]: "cubic-bezier(0.1, 0.2, 0.3, 0.4)",
  [ANIMATE_SCROLL_PROPERTY]: "0",
};

function newTickOptions(): TickOptions {
  return {
    eventCreationTime: -1,
    isPlaying: true,
    globalLyricOffset: 0,
    lyricOffset: 0,
    richsyncOffsetTrim: 0,
    lineOffsetTrim: 0,
    passiveScrollEnabled: false,
  };
}

// relayout() measures through offsetParent and DOMRect, which no fake can answer honestly. Line
// positions are data, so the fixture writes what a measurement would have produced.
function placeLines(engine: AnimationEngineInstance): void {
  getRenderedLines(engine).forEach((line, index) => {
    line.position = index * LINE_HEIGHT_PX;
    line.height = LINE_HEIGHT_PX;
  });
}

function renderedLineElements(mount: FakeNode): FakeNode[] {
  const container = mount.childNodes[0];
  if (!container) return [];
  return container.childNodes.filter(child => child.classList.contains(LINE_CLASS));
}

function foreignNodeNames(root: FakeNode, owner: FakeDocument): string[] {
  return collectTree(root)
    .filter(node => node.ownerDocument !== owner)
    .map(node => node.name);
}

function soleMediaQuery(fakeWindow: FakeWindow): FakeMediaQueryList {
  const lists = [...fakeWindow.mediaQueryLists.values()];
  assert.equal(
    lists.length,
    1,
    "Given an instance, When its window is read, Then it asked that window about exactly one media query"
  );
  return lists[0];
}

// -- Two instances --------------------------------------------

const panelDocument = new FakeDocument();
const panelWindow = new FakeWindow(PANEL_STYLE);
const panelHost = new FakeHost(undefined, panelDocument);
const panelMount = panelDocument.createElement("div");
const panelEngine = createAnimationEngineInstance(asDocument(panelDocument), asWindow(panelWindow), panelHost);

const floatingDocument = new FakeDocument();
const floatingWindow = new FakeWindow(FLOATING_STYLE);
const floatingHost = new FakeHost(undefined, floatingDocument);
const floatingMount = floatingDocument.createElement("div");
const floatingEngine = createAnimationEngineInstance(
  asDocument(floatingDocument),
  asWindow(floatingWindow),
  floatingHost
);

const viewNames = new Map<AnimationEngineInstance, string>([
  [panelEngine, "panel"],
  [floatingEngine, "floating"],
]);

function liveViewNames(): string[] {
  const names: string[] = [];
  forEveryLiveView(engine => names.push(viewNames.get(engine) ?? "unknown"));
  return names.sort();
}

assert.deepEqual(
  liveViewNames(),
  ["floating", "panel"],
  "Given two created instances, When the registry is walked, Then it visits both"
);

// -- One view's lyrics are its own --------------------------------------------

setLyrics(panelEngine, asElement<HTMLElement>(panelMount), RICH_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});

assert.equal(
  hasRenderedLines(panelEngine),
  true,
  "Given lyrics set on one instance, When it is asked, Then it reports the lines it built"
);

assert.equal(
  hasRenderedLines(floatingEngine),
  false,
  "Given lyrics set on one instance, When the other is asked, Then it reports none"
);

assert.equal(
  getRenderedSyncType(panelEngine),
  "richsync",
  "Given rich synced lyrics set on one instance, When it is asked, Then it reports its own sync type"
);

assert.equal(
  getRenderedSyncType(floatingEngine),
  "none",
  "Given lyrics set on one instance, When the other is asked, Then its sync type is untouched"
);

assert.equal(
  clearOnScreenLyrics(floatingEngine),
  false,
  "Given lyrics set on one instance, When the other is asked to clear the screen, Then it has no container to clear"
);

assert.equal(
  floatingMount.childNodes.length,
  0,
  "Given lyrics set on one instance, When the other's mount is walked, Then nothing was built into it"
);

assert.deepEqual(
  foreignNodeNames(panelMount, panelDocument),
  [],
  "Given a view built by one instance, When its tree is walked, Then every node came from that instance's document"
);

setLyrics(floatingEngine, asElement<HTMLElement>(floatingMount), LINE_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});

assert.equal(
  getRenderedLines(panelEngine).length,
  RICH_SYNCED_LYRICS.length,
  "Given lyrics set on the second instance, When the first is asked, Then it still holds its own lines"
);

assert.equal(
  getRenderedSyncType(panelEngine),
  "richsync",
  "Given line synced lyrics set on the second instance, When the first is asked, Then it still reports its own sync type"
);

assert.equal(
  getRenderedSyncType(floatingEngine),
  "synced",
  "Given line synced lyrics set on the second instance, When it is asked, Then it reports its own sync type"
);

assert.deepEqual(
  foreignNodeNames(floatingMount, floatingDocument),
  [],
  "Given a second view built by the other instance, When its tree is walked, Then every node came from that instance's document"
);

placeLines(panelEngine);
placeLines(floatingEngine);

const panelContainer = panelMount.childNodes[0];
const floatingContainer = floatingMount.childNodes[0];

// -- A user scroll reaches one view --------------------------------------------

// Setting lyrics arms the view to swallow the scrolls it is about to perform itself, so the
// swallowed ones have to be spent before a user scroll can land.
const swallowedScrolls = panelEngine.skipScrolls;
assert.ok(
  swallowedScrolls > 0,
  "Given freshly set lyrics, When the view is asked, Then it is armed to swallow the scrolls it performs itself"
);

for (let scroll = 0; scroll <= swallowedScrolls; scroll++) {
  noteUserScroll(panelEngine, false);
}

assert.deepEqual(
  panelHost.resumeAffordanceCalls,
  [true],
  "Given the view's own scrolls followed by a user's, When they are noted, Then only the user's offers the way back"
);

assert.equal(
  panelContainer.classList.contains(USER_SCROLLING_CLASS),
  true,
  "Given a user scroll on one view, When its container is read, Then it records that the user took over"
);

assert.deepEqual(
  floatingHost.resumeAffordanceCalls,
  [],
  "Given a user scroll on one view, When the other's host is asked, Then it was never told to offer anything"
);

assert.equal(
  floatingContainer.classList.contains(USER_SCROLLING_CLASS),
  false,
  "Given a user scroll on one view, When the other's container is read, Then it records nothing"
);

assert.equal(
  floatingEngine.scrollResumeTime,
  0,
  "Given a user scroll on one view, When the other's autoscroll is read, Then it was never paused"
);

// -- Each view resolves its own styles --------------------------------------------

const panelLogsBeforeTick = panelHost.logs.length;

// The tick swallows its own exceptions, so a fake too thin to reach the style reads would leave
// every assertion below reading an empty cache rather than reporting the real failure.
assert.equal(
  tickView(panelEngine, PLAYBACK_TIME_S, resolveTickOptions(newTickOptions())),
  "ok",
  "Given a built view, When it ticks, Then it reports that it rendered"
);

assert.equal(
  tickView(floatingEngine, PLAYBACK_TIME_S, resolveTickOptions(newTickOptions())),
  "ok",
  "Given a second built view, When it ticks, Then it reports that it rendered"
);

assert.deepEqual(
  panelHost.logs.slice(panelLogsBeforeTick),
  [],
  "Given a tick over a built view, When it finishes, Then it reported nothing wrong to its host"
);

assert.deepEqual(
  floatingHost.logs,
  [],
  "Given a tick over the second built view, When it finishes, Then it reported nothing wrong to its host"
);

assert.equal(
  panelEngine.cachedDurations.get(SCROLL_TIMING_OFFSET_PROPERTY),
  20,
  "Given two documents answering one property differently, When both views tick, Then each cached its own document's duration"
);

assert.equal(
  floatingEngine.cachedDurations.get(SCROLL_TIMING_OFFSET_PROPERTY),
  -70,
  "Given two documents answering one property differently, When both views tick, Then neither took the other's duration"
);

assert.equal(
  panelEngine.cachedCSSValues.get(SCROLL_EASING_PROPERTY),
  "ease-in",
  "Given two documents answering one property differently, When both views tick, Then each cached its own document's value"
);

assert.equal(
  floatingEngine.cachedCSSValues.get(SCROLL_EASING_PROPERTY),
  "cubic-bezier(0.1, 0.2, 0.3, 0.4)",
  "Given two documents answering one property differently, When both views tick, Then neither took the other's value"
);

assert.equal(
  [...panelEngine.cachedCSSValues.values()].includes("cubic-bezier(0.1, 0.2, 0.3, 0.4)"),
  false,
  "Given the other document's values, When one view's style cache is read, Then it holds none of them"
);

assert.equal(
  panelEngine.cachedAnimationSettings?.config.lineScroll.easing,
  "ease-in",
  "Given two documents with different scroll easings, When both views tick, Then each read its own into its settings"
);

assert.equal(
  floatingEngine.cachedAnimationSettings?.config.lineScroll.easing,
  "cubic-bezier(0.1, 0.2, 0.3, 0.4)",
  "Given two documents with different scroll easings, When both views tick, Then neither read the other's into its settings"
);

assert.equal(
  panelEngine.cachedAnimationSettings?.scrollTiming.earlyScrollConsiderS,
  floatingEngine.cachedAnimationSettings?.scrollTiming.earlyScrollConsiderS,
  "Given different animation easings, both views retain the same independent lookahead"
);

assert.deepEqual(
  panelWindow.computedStyleTargets.filter(node => node.ownerDocument !== panelDocument).map(node => node.name),
  [],
  "Given a tick, When one view resolves its styles, Then every element it measured came from its own document"
);

assert.deepEqual(
  floatingWindow.computedStyleTargets.filter(node => node.ownerDocument !== floatingDocument).map(node => node.name),
  [],
  "Given a tick, When the other view resolves its styles, Then every element it measured came from its own document"
);

// The style values reach the DOM, not just the cache: one document switches scroll animation on and
// the other switches it off, so only one view promotes the lines it is about to move.
assert.equal(
  renderedLineElements(panelMount).filter(line => "will-change" in line.style.properties).length,
  RICH_SYNCED_LYRICS.length,
  "Given a document that enables scroll animation, When its view ticks, Then it promotes its visible lines"
);

assert.equal(
  renderedLineElements(floatingMount).filter(line => "will-change" in line.style.properties).length,
  0,
  "Given a document that disables scroll animation, When its view ticks, Then it promotes nothing"
);

// -- A reduced motion change reaches one view --------------------------------------------

assert.equal(
  soleMediaQuery(panelWindow).listeners.size,
  1,
  "Given a created instance, When its window is read, Then it registered one reduced motion listener there"
);

soleMediaQuery(panelWindow).dispatchChange();

assert.equal(
  panelEngine.cachedDurations.size,
  0,
  "Given a reduced motion change on one window, When the caches are read, Then that window's view dropped its own"
);

assert.ok(
  floatingEngine.cachedDurations.size > 0,
  "Given a reduced motion change on one window, When the caches are read, Then the other view kept its own"
);

assert.notEqual(
  floatingEngine.cachedAnimationSettings,
  null,
  "Given a reduced motion change on one window, When the other view's settings are read, Then they survived"
);

// -- Dropping one view's song leaves the other's --------------------------------------------

clearLyrics(panelEngine);

assert.equal(
  hasRenderedLines(panelEngine),
  false,
  "Given a view whose song was dropped, When it is asked, Then it holds no lines"
);

assert.equal(
  hasRenderedLines(floatingEngine),
  true,
  "Given one view's song dropped, When the other is asked, Then it still holds its own lines"
);

assert.equal(
  getRenderedLines(floatingEngine).length,
  LINE_SYNCED_LYRICS.length,
  "Given one view's song dropped, When the other's lines are counted, Then all of them are still there"
);

assert.equal(
  getRenderedSyncType(floatingEngine),
  "synced",
  "Given one view's song dropped, When the other is asked, Then it still reports its own sync type"
);

assert.equal(
  clearOnScreenLyrics(floatingEngine),
  true,
  "Given one view's song dropped, When the other is asked to clear the screen, Then it still has a container to clear"
);

// -- The last line can always be scrolled to its target position ------------------------------
// The scroll stops at the end of the content, so the last line only reaches the target position if
// the content runs far enough past it. Under-padding strands the end of every song, and the tell is
// a viewport that grew: fullscreen asks for far more room below the last line than a side panel.

const VIEWPORT_HEIGHT_FULLSCREEN = 1384;
const TARGET_SCROLL_RATIO = 0.37;
const TAIL_SPACE_DEMANDED = VIEWPORT_HEIGHT_FULLSCREEN * (1 - TARGET_SCROLL_RATIO);

const renderedMeasurements = {
  viewportHeight: VIEWPORT_HEIGHT_FULLSCREEN,
  targetScrollRatio: TARGET_SCROLL_RATIO,
  contentHeight: 5939,
  firstLineHeight: 100,
  lastLineCentre: 5543,
  lastLineHeight: 120,
  footerHeight: 38,
};

const rendered = computeScrollPadding(renderedMeasurements);

assert.ok(
  rendered.bottom + (renderedMeasurements.contentHeight - renderedMeasurements.lastLineCentre) >= TAIL_SPACE_DEMANDED,
  "Given a rendering view, When its padding is sized, Then the last line can reach the target scroll position"
);

// Every measurement taken from a container that is not rendering comes back zero.
const unrendered = computeScrollPadding({
  viewportHeight: VIEWPORT_HEIGHT_FULLSCREEN,
  targetScrollRatio: TARGET_SCROLL_RATIO,
  contentHeight: 0,
  firstLineHeight: 0,
  lastLineCentre: 0,
  lastLineHeight: 0,
  footerHeight: 0,
});

assert.ok(
  unrendered.bottom >= TAIL_SPACE_DEMANDED,
  "Given a container measured while it was not rendering, When its padding is sized, Then it still reserves what the viewport demands rather than nothing"
);

assert.equal(
  computeScrollPadding({
    viewportHeight: VIEWPORT_HEIGHT_FULLSCREEN,
    targetScrollRatio: TARGET_SCROLL_RATIO,
    contentHeight: 99999,
    firstLineHeight: 0,
    lastLineCentre: null,
    lastLineHeight: 0,
    footerHeight: 0,
  }).bottom,
  Math.ceil(TAIL_SPACE_DEMANDED),
  "Given no lines at all, When the padding is sized, Then the floor is what the viewport demands"
);

assert.ok(
  computeScrollPadding({ ...renderedMeasurements, viewportHeight: 580 }).bottom < rendered.bottom,
  "Given a smaller viewport, When the padding is sized, Then it asks for less room than fullscreen did"
);

// -- Several active lines stay inside the visible band --------------------------------------------

const NO_INSETS = resolveScrollInsets("auto", "auto", 400);

assert.deepEqual(
  [
    resolveScrollInsets("12%", "16%", 250),
    resolveScrollInsets("30px", "0px", 250),
    resolveScrollInsets("-10px", "", 250),
    NO_INSETS,
  ],
  [
    { top: 30, bottom: 40 },
    { top: 30, bottom: 0 },
    { top: 0, bottom: 0 },
    { top: 0, bottom: 0 },
  ],
  "Given scroll-padding in percent, pixels, a negative or nothing, When the insets are resolved, Then each is a pixel inset and only positive ones count"
);

assert.deepEqual(
  resolveScrollInsets("60%", "50%", 250),
  { top: 0, bottom: 0 },
  "Given insets that leave no band, When they are resolved, Then they are ignored rather than obeyed"
);

const bandTop = (scrollTop: number, insets: { top: number }) => scrollTop + insets.top;
const bandBottom = (scrollTop: number, height: number, insets: { bottom: number }) =>
  scrollTop + height - insets.bottom;
const isInBand = (
  line: { position: number; height: number },
  scrollTop: number,
  height: number,
  insets: { top: number; bottom: number }
) =>
  line.position >= bandTop(scrollTop, insets) && line.position + line.height <= bandBottom(scrollTop, height, insets);

const shortPair = [
  { time: 10, duration: 4, position: 1000, height: 40 },
  { time: 12, duration: 4, position: 1050, height: 40 },
];
assert.deepEqual(
  computeActiveLinesScrollTop(shortPair, shortPair[0], 400, NO_INSETS, 148),
  { scrollTop: 1045 - 148, overflowsBand: false },
  "Given two active lines that fit, When the scroll target is computed, Then their shared centre sits at the target"
);

for (const insets of [NO_INSETS, resolveScrollInsets("12%", "16%", 260)]) {
  for (const anchor of shortPair) {
    const { scrollTop } = computeActiveLinesScrollTop(shortPair, anchor, 260, insets, 96);
    assert.ok(
      shortPair.every(line => isInBand(line, scrollTop, 260, insets)),
      "Given active lines that fit the band, When the scroll target is computed, Then every one of them is inside it whichever is the anchor"
    );
  }
}

const fittingGroups = [
  [
    { time: 10, duration: 4, position: 1000, height: 80 },
    { time: 12, duration: 4, position: 1090, height: 80 },
  ],
  [
    { time: 10, duration: 6, position: 1000, height: 40 },
    { time: 11, duration: 5, position: 1050, height: 40 },
    { time: 12, duration: 4, position: 1100, height: 40 },
  ],
];
for (const group of fittingGroups) {
  const insets = resolveScrollInsets("12%", "16%", 260);
  for (const anchor of group) {
    const { scrollTop, overflowsBand } = computeActiveLinesScrollTop(group, anchor, 260, insets, 96);
    assert.ok(
      !overflowsBand && group.every(line => isInBand(line, scrollTop, 260, insets)),
      "regression: Given taller or more active lines that still fit the band, When a later line is the anchor, Then the first line is not pushed into the fade"
    );
  }
}

const lowTargetPair = [
  { time: 0, duration: 4, position: 0, height: 190 },
  { time: 2, duration: 4, position: 190, height: 190 },
];
assert.equal(
  computeActiveLinesScrollTop(lowTargetPair, lowTargetPair[1], 400, NO_INSETS, 40).scrollTop,
  0,
  "regression: Given a view with no scroll padding and a low target, When two lines fit it, Then both stay fully in view"
);

assert.deepEqual(
  [
    findScrollAnchor(shortPair, 11),
    findScrollAnchor(shortPair, 12),
    findScrollAnchor(shortPair, 9.5),
    findScrollAnchor(shortPair, 17),
  ],
  [shortPair[0], shortPair[1], shortPair[0], shortPair[1]],
  "Given active lines, When the anchor is chosen, Then it is the latest that has started, or the first while none has"
);

const heldLine = { ...shortPair[0], duration: 10 };
const shortLine = { ...shortPair[1], duration: 1 };
assert.equal(
  findScrollAnchor([heldLine, shortLine], 13.5),
  heldLine,
  "Given a later line that has already ended, When the anchor is chosen, Then an earlier line still being sung wins"
);

const PIP_VERTICAL_HEIGHT = 180;
const pipInsets = resolveScrollInsets("12%", "16%", PIP_VERTICAL_HEIGHT);
const PIP_TARGET_OFFSET = PIP_VERTICAL_HEIGHT * TARGET_SCROLL_RATIO;
const [echoLine, leadLine] = [
  { time: 138, duration: 5.8, position: 1000, height: 92 },
  { time: 142.5, duration: 3, position: 1102, height: 92 },
];

const leadTarget = computeActiveLinesScrollTop(
  [echoLine, leadLine],
  findScrollAnchor([echoLine, leadLine], 142.6),
  PIP_VERTICAL_HEIGHT,
  pipInsets,
  PIP_TARGET_OFFSET
);
assert.ok(
  leadTarget.overflowsBand && isInBand(leadLine, leadTarget.scrollTop, PIP_VERTICAL_HEIGHT, pipInsets),
  "regression: Given a line's background echo still running when the next line starts, When both overflow the faded band, Then the line the singer is on stays fully readable"
);

const lookaheadTarget = computeActiveLinesScrollTop(
  [echoLine, leadLine],
  findScrollAnchor([echoLine, leadLine], 142.1),
  PIP_VERTICAL_HEIGHT,
  pipInsets,
  PIP_TARGET_OFFSET
);
assert.ok(
  isInBand(echoLine, lookaheadTarget.scrollTop, PIP_VERTICAL_HEIGHT, pipInsets),
  "regression: Given the next line in its lookahead, When it does not fit beside the line being sung, Then the line being sung is not pushed into the fade early"
);

const oversizedLine = [{ time: 0, duration: 5, position: 500, height: 600 }];
assert.equal(
  computeActiveLinesScrollTop(oversizedLine, oversizedLine[0], PIP_VERTICAL_HEIGHT, pipInsets, 66).scrollTop,
  500 - pipInsets.top,
  "Given one line taller than the band, When the scroll target is computed, Then its top sits at the top of the band"
);

// A view pinned to a line has to move on once another line becomes the anchor, or a tail that is
// still being sung stays scrolled off screen until some other line happens to start.
const OVERLAP_LINE_HEIGHT_PX = 300;
const OVERLAP_LYRICS: Lyric[] = [
  { startTimeMs: 0, durationMs: 9000, words: "A long line whose echo runs under the next" },
  { startTimeMs: 4000, durationMs: 2000, words: "A short line sung over the echo" },
  { startTimeMs: 12000, durationMs: 4000, words: "A line far enough away not to matter" },
];
const overlapDocument = new FakeDocument();
const overlapHost = new FakeHost(undefined, overlapDocument);
const overlapEngine = createAnimationEngineInstance(
  asDocument(overlapDocument),
  asWindow(new FakeWindow({ [ANIMATE_SCROLL_PROPERTY]: "0" })),
  overlapHost
);
setLyrics(overlapEngine, asElement<HTMLElement>(overlapDocument.createElement("div")), OVERLAP_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
getRenderedLines(overlapEngine).forEach((line, index) => {
  line.position = index * (OVERLAP_LINE_HEIGHT_PX + 10);
  line.height = OVERLAP_LINE_HEIGHT_PX;
});
const tickOverlapUntil = (fromTenths: number, toTenths: number) => {
  for (let tenths = fromTenths; tenths <= toTenths; tenths++) {
    tickView(overlapEngine, tenths / 10, resolveTickOptions(newTickOptions()));
  }
};
const [echoingLine, interjectedLine] = getRenderedLines(overlapEngine);
const overlapScrollTop = () => overlapHost.scrollElement.scrollTop;

tickOverlapUntil(30, 45);
assert.ok(
  isInBand(interjectedLine, overlapScrollTop(), VIEWPORT_HEIGHT_PX, NO_INSETS),
  "Given a line starting over another's echo, When both overflow the view, Then the new line is the one in view"
);

const interjectedScrollTop = overlapScrollTop();
tickView(overlapEngine, 4.3, resolveTickOptions(newTickOptions()));
tickView(overlapEngine, 3.95, resolveTickOptions(newTickOptions()));
assert.equal(
  overlapScrollTop(),
  interjectedScrollTop,
  "regression: Given a view pinned to a line that has just started, When the clock steps back a little before it, Then the view does not flip back to the earlier line"
);
tickOverlapUntil(40, 45);

tickOverlapUntil(46, 65);
assert.ok(
  isInBand(echoingLine, overlapScrollTop(), VIEWPORT_HEIGHT_PX, NO_INSETS),
  "regression: Given a view pinned to a line that stops being sung, When only the echo is left, Then the view moves back to it without waiting for another line to start"
);
overlapEngine.destroy();

// -- The "no lyrics" message is not unsynced lyrics --------------------------------------------
// Its own instance, so the pending frame the positive control leaves behind cannot reach the
// destroy assertions below.

const placeholderDocument = new FakeDocument();
const placeholderWindow = new FakeWindow(PANEL_STYLE);
const placeholderEngine = createAnimationEngineInstance(
  asDocument(placeholderDocument),
  asWindow(placeholderWindow),
  new FakeHost()
);
const placeholderMount = placeholderDocument.createElement("div");
const passiveTickOptions: TickOptions = { ...newTickOptions(), passiveScrollEnabled: true };

// -- The rate a tick was taken at --------------------------------------------

assert.equal(
  resolveTickOptions(newTickOptions()).playbackRate,
  1,
  "Given a tick that says nothing about rate, When it is resolved, Then the song is taken to be playing at 1x"
);

assert.deepEqual(
  [-1, 0, Number.NaN, Number.POSITIVE_INFINITY].map(
    rate => resolveTickOptions({ ...newTickOptions(), playbackRate: rate }).playbackRate
  ),
  [1, 1, 1, 1],
  "Given a rate no song can be played at, When it is resolved, Then it reads as 1x rather than freezing everything the song owns"
);

assert.equal(
  resolveTickOptions({ ...newTickOptions(), playbackRate: 0.25 }).playbackRate,
  0.25,
  "Given a rate a song can be played at, When it is resolved, Then it is passed through"
);

setLyrics(placeholderEngine, asElement<HTMLElement>(placeholderMount), UNSYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
tickView(placeholderEngine, PLAYBACK_TIME_S, resolveTickOptions(passiveTickOptions));

assert.notEqual(
  placeholderEngine.passiveRAFId,
  null,
  "Given unsynced lyrics and passive scroll switched on, When the view ticks, Then it drives the passive scroll loop"
);

setLyrics(placeholderEngine, asElement<HTMLElement>(placeholderMount), NO_LYRICS_PLACEHOLDER, {
  loaderVisible: false,
  noLyrics: true,
});
tickView(placeholderEngine, PLAYBACK_TIME_S, resolveTickOptions(passiveTickOptions));

assert.equal(
  placeholderEngine.passiveRAFId,
  null,
  "Given the no lyrics message, When the view ticks with passive scroll switched on, Then nothing scrolls it"
);

relayout(placeholderEngine, false);

assert.equal(
  asFakeNode(placeholderEngine.lyricsContainer!).style.getPropertyValue("padding-bottom"),
  "0px",
  "regression: Given the no lyrics message, When the view sizes its scroll room, Then it adds none, so nothing scrolls and what follows the message stays in view"
);
assert.equal(
  placeholderDocument.documentElement.style.getPropertyValue("--blyrics-padding-top"),
  "0px",
  "Given the no lyrics message, When the view sizes its scroll room, Then it asks for none above the message either"
);

placeholderEngine.destroy();

// -- The end of the song is somewhere the scroll can actually reach -----------------------------

const OUTRO_LINE_HEIGHT_PX = 60;
const OUTRO_LAST_LINE_POSITION_PX = 3000;
const UNPADDED_CONTENT_HEIGHT_PX = OUTRO_LAST_LINE_POSITION_PX + OUTRO_LINE_HEIGHT_PX;

const outroDocument = new FakeDocument();
const outroWindow = new FakeWindow({ [ANIMATE_SCROLL_PROPERTY]: "0" });
const outroHost = new FakeHost(UNPADDED_CONTENT_HEIGHT_PX);
const outroMount = outroDocument.createElement("div");
const outroEngine = createAnimationEngineInstance(asDocument(outroDocument), asWindow(outroWindow), outroHost);

setLyrics(outroEngine, asElement<HTMLElement>(outroMount), LINE_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});

getRenderedLines(outroEngine).forEach((line, index, lines) => {
  line.position = OUTRO_LAST_LINE_POSITION_PX - (lines.length - 1 - index) * OUTRO_LINE_HEIGHT_PX;
  line.height = OUTRO_LINE_HEIGHT_PX;
});

const LAST_LINE_TIME_S = LINE_SYNCED_LYRICS[LINE_SYNCED_LYRICS.length - 1].startTimeMs / 1000;
tickView(outroEngine, LAST_LINE_TIME_S, resolveTickOptions(newTickOptions()));

// The positive control: a fixture too thin to reach the scroll maths would pass the next assertion
// by never having scrolled at all.
assert.ok(
  outroHost.scrollElement.scrollTop > 0,
  "Given the last line of a song, When the view ticks at its time, Then it scrolled towards that line at all"
);

assert.equal(
  outroEngine.scrollPos,
  outroHost.scrollElement.scrollTop,
  "Given a container a theme left too short to centre the last line, When the view scrolls to it, Then it aims where the scroll can go rather than past the end of the content"
);

// -- The room below the last line is taken, not asked for --------------------------------------

relayout(outroEngine, false);

const outroContainer = asFakeNode(outroEngine.lyricsContainer!);

assert.ok(
  Number.parseFloat(outroContainer.style.getPropertyValue("padding-bottom")) > 0,
  "Given a view sizing the room below its last line, When the container is read, Then it carries that room where no theme rule can outrank it"
);

assert.equal(
  outroContainer.style.getPropertyValue("padding-bottom"),
  outroDocument.documentElement.style.getPropertyValue("--blyrics-padding-bottom"),
  "Given a view sizing the room below its last line, When the published property is read, Then it still names the length the container took"
);

outroEngine.destroy();

// -- Destroying one view releases only what it held --------------------------------------------

scheduleLyricPositionUpdate(
  panelEngine,
  () => assert.fail("A cancelled frame must not ask whether the view is rendering"),
  () => assert.fail("A cancelled frame must not re-tick")
);

const queuedFrame = panelEngine.pendingLyricsUpdateFrame;
assert.notEqual(queuedFrame, null, "Given a scheduled position update, When the view is read, Then it holds a frame");

panelEngine.destroy();

assert.deepEqual(
  liveViewNames(),
  ["floating"],
  "Given a destroyed instance, When the registry is walked, Then it visits only the survivor"
);

assert.equal(
  soleMediaQuery(panelWindow).listeners.size,
  0,
  "Given a destroyed instance, When its window is read, Then its reduced motion listener is gone"
);

assert.equal(
  soleMediaQuery(floatingWindow).listeners.size,
  1,
  "Given one destroyed instance, When the other's window is read, Then its reduced motion listener is untouched"
);

assert.deepEqual(
  panelWindow.resizeObservers.map(observer => observer.disconnected),
  [true],
  "Given a destroyed instance, When the observers it made are read, Then the one watching its scroll container stopped"
);

assert.deepEqual(
  floatingWindow.resizeObservers.map(observer => observer.disconnected),
  [false],
  "Given one destroyed instance, When the other's observers are read, Then its own is still watching"
);

assert.deepEqual(
  panelWindow.cancelledFrames,
  [queuedFrame],
  "Given a destroyed instance with a frame queued, When it is destroyed, Then it cancels that frame on its own window"
);

assert.deepEqual(
  floatingWindow.cancelledFrames,
  [],
  "Given one destroyed instance, When the other's window is read, Then nothing was cancelled on it"
);

// The tick swallows exceptions, so a read of an ambient global inside it would throw where nobody
// can see. The count is what carries that failure out.
assert.equal(
  ambientGlobals.reads,
  0,
  "Given two views driven from build to destruction, When they finish, Then neither read an ambient global document or window"
);

// -- Off-screen line culling --------------------------------------------

// A window offering an IntersectionObserver skips off-screen lines; one without leaves all rendered.

const cullDocument = new FakeDocument();
const cullWindow = new FakeWindow(PANEL_STYLE, { intersectionObserver: true });
const cullHost = new FakeHost();
const cullMount = cullDocument.createElement("div");
const cullEngine = createAnimationEngineInstance(asDocument(cullDocument), asWindow(cullWindow), cullHost);

setLyrics(cullEngine, asElement<HTMLElement>(cullMount), LINE_SYNCED_LYRICS, { loaderVisible: false, noLyrics: false });

const cullLines = renderedLineElements(cullMount);
const cullObserver = cullWindow.intersectionObservers.at(-1);
assert(cullObserver, "Given a window offering an IntersectionObserver, When lyrics are set, Then one is created");
assert.equal(
  cullObserver.targets.length,
  cullLines.length,
  "Given lyrics are set, When the culling observer arms, Then it observes every line"
);
assert.equal(
  cullHost.scrollElement.style.getPropertyValue("overflow-anchor"),
  "none",
  "Given culling arms, When the observer is set up, Then scroll anchoring is disabled on the container so a cull height-shift cannot fire a scroll the engine misreads as the user's"
);
for (const line of cullLines) {
  assert.notEqual(
    line.style.getPropertyValue("contain-intrinsic-block-size"),
    "",
    "Given lyrics are set, When the observer arms, Then each line carries a skipped-size placeholder"
  );
  assert.equal(
    line.style.getPropertyValue("content-visibility"),
    "",
    "Given lyrics are set, When no line has been reported off-screen, Then none is skipped"
  );
}

cullObserver.report(cullLines[0], false);
assert.equal(
  cullLines[0].style.getPropertyValue("content-visibility"),
  "auto",
  "Given a line, When it is reported off-screen, Then it is skipped"
);

cullObserver.report(cullLines[0], true);
assert.equal(
  cullLines[0].style.getPropertyValue("content-visibility"),
  "",
  "Given a skipped line, When it is reported back on-screen, Then it renders again"
);

cullObserver.report(cullLines[1], true);
assert.equal(
  cullLines[1].style.getPropertyValue("content-visibility"),
  "",
  "Given an on-screen line, When it is reported, Then it is never skipped"
);

cullObserver.report(cullLines[2], false);
clearLyrics(cullEngine);
assert.equal(
  cullObserver.disconnected,
  true,
  "Given a song with a culling observer, When it is cleared, Then the observer is disconnected"
);
assert.equal(
  cullLines[2].style.getPropertyValue("content-visibility"),
  "",
  "Given a skipped line, When the song is cleared, Then it is un-skipped"
);

// A window without an IntersectionObserver leaves every line rendered rather than failing.
const noCullDocument = new FakeDocument();
const noCullWindow = new FakeWindow(PANEL_STYLE);
const noCullHost = new FakeHost();
const noCullEngine = createAnimationEngineInstance(asDocument(noCullDocument), asWindow(noCullWindow), noCullHost);
const noCullMount = noCullDocument.createElement("div");
setLyrics(noCullEngine, asElement<HTMLElement>(noCullMount), LINE_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
assert.equal(
  noCullWindow.intersectionObservers.length,
  0,
  "Given a window with no IntersectionObserver, When lyrics are set, Then culling arms nothing and the lines render"
);
assert.equal(
  noCullHost.scrollElement.style.getPropertyValue("overflow-anchor"),
  "",
  "Given no IntersectionObserver, When culling cannot arm, Then anchoring is left untouched because no cull height-shift occurs"
);
setupLineCullObserver(noCullEngine); // safe to call directly with no observer support
clearLyrics(noCullEngine);

// Per-letter swipe windows: each letter owns the slice of the sweep where its own reveal happens,
// holding hidden before and shown after, so only the letters under the moving edge keep animating.
const SWIPE_RAMP = { easing: "linear", startFrom: "-0.2", startTo: "1.4", endFrom: "-0.1", endTo: "1.5" };
const SWIPE_DURATION_MS = 1000;
const SWIPE_LETTERS = 5;
const swipeWindows = computeLetterSwipeWindows(SWIPE_RAMP, SWIPE_LETTERS, SWIPE_DURATION_MS);
assert.ok(swipeWindows, "Given a linear forward ramp, When windows are computed, Then it returns them");
assert.equal(swipeWindows.length, SWIPE_LETTERS, "Given N letters, Then there is one window each");
const SWIPE_EPS = 1e-6;
swipeWindows.forEach((window, index) => {
  assert.ok(
    window.delayMs >= -SWIPE_EPS && window.delayMs <= SWIPE_DURATION_MS + SWIPE_EPS,
    "Given a window, Then its delay sits inside the sweep"
  );
  assert.ok(window.durationMs > 0, "Given a window, Then it animates over a real span");
  // The held "from" value renders the letter empty: its transparent edge sits at or before its start.
  assert.ok(
    window.from.end * SWIPE_LETTERS - index <= SWIPE_EPS,
    "Given the value held before a letter's slice, Then the letter is fully unfilled"
  );
  // The held "to" value renders the letter filled: its active edge covers the whole letter.
  assert.ok(
    window.to.start * SWIPE_LETTERS - index >= 1 - SWIPE_EPS,
    "Given the value held after a letter's slice, Then the letter is fully filled"
  );
  const next = swipeWindows[index + 1];
  if (next) {
    assert.ok(next.delayMs >= window.delayMs - SWIPE_EPS, "Given consecutive letters, Then their slices advance");
    assert.ok(
      next.delayMs <= window.delayMs + window.durationMs + SWIPE_EPS,
      "Given consecutive letters, Then their slices overlap so the sweep never gaps"
    );
  }
});
assert.equal(
  computeLetterSwipeWindows({ ...SWIPE_RAMP, easing: "ease" }, SWIPE_LETTERS, SWIPE_DURATION_MS),
  null,
  "Given a non-linear ramp, When windows are computed, Then it defers to the single-property sweep"
);
assert.equal(
  computeLetterSwipeWindows({ ...SWIPE_RAMP, startTo: "-0.4" }, SWIPE_LETTERS, SWIPE_DURATION_MS),
  null,
  "Given a ramp that does not move forward, Then it defers to the single-property sweep"
);
assert.equal(
  computeLetterSwipeWindows(SWIPE_RAMP, 0, SWIPE_DURATION_MS),
  null,
  "Given a word with no letters, Then there are no per-letter windows"
);

// planLetterMaskSweep hands every letter-split word a reveal, even where computeLetterSwipeWindows
// bails: the whole-word gradient is off for letter words, so without the fallback they snap to fully
// highlighted instead of sweeping.
const linearSweep = planLetterMaskSweep(SWIPE_RAMP, SWIPE_LETTERS, SWIPE_DURATION_MS, false);
assert.equal(linearSweep.length, SWIPE_LETTERS, "Given a linear ramp, Then every letter gets a mask sweep");
assert.ok(
  linearSweep.every(sweep => sweep.easing === "linear" && sweep.keyframes.length === 2),
  "Given a linear ramp, Then each letter rides the short windowed plan"
);

for (const easing of ["ease", "cubic-bezier(0.4, 0, 0.2, 1)"]) {
  const sweep = planLetterMaskSweep({ ...SWIPE_RAMP, easing }, SWIPE_LETTERS, SWIPE_DURATION_MS, false);
  assert.equal(sweep.length, SWIPE_LETTERS, "Given a non-linear ramp, When planned, Then every letter still reveals");
  assert.ok(
    sweep.every(entry => entry.easing === easing && entry.durationMs === SWIPE_DURATION_MS && entry.delayMs === 0),
    "Given a non-linear ramp, Then each letter runs the whole duration under the theme easing"
  );
  assert.ok(
    sweep.every(entry => entry.keyframes[0].offset === 0 && entry.keyframes.at(-1)?.offset === 1),
    "Given a non-linear ramp, Then each letter's reveal spans the whole timeline"
  );
  assert.ok(
    sweep.every(
      (entry, index) => entry.keyframes.at(-1)?.maskPosition === linearSweep[index].keyframes.at(-1)?.maskPosition
    ),
    "Given a non-linear ramp, Then each letter ends at the same fully-revealed mask as the linear plan, not swept past"
  );
  assert.ok(
    sweep.every((entry, index) => entry.keyframes[0].maskPosition === linearSweep[index].keyframes[0].maskPosition),
    "Given a non-linear ramp, Then each letter starts hidden, the same as the linear plan"
  );
}

assert.deepEqual(
  planLetterMaskSweep(SWIPE_RAMP, 0, SWIPE_DURATION_MS, false),
  [],
  "Given a word with no letters, Then there is nothing to sweep"
);

// With the default ramp the swipe touches letter i at i/n of the word and has lit it 1/n + 0.1 of the
// word later. A long word lights each letter slower than a 900ms float rises, so each starts as it is
// touched and stretches its float to crest as it is lit. A short word lights them faster, so each
// keeps the 900ms float and starts early enough to crest as it is lit, the first ones before the word.
const waves = (wordMs: number) =>
  planLetterWave(SWIPE_RAMP, SWIPE_LETTERS, wordMs, wordMs * 1.6, wordMs * 0.1, 900).map(wave => [
    Math.round(wave.delayMs),
    Math.round(wave.durationMs),
  ]);
assert.deepEqual(
  waves(3200),
  [
    [0, 2400],
    [640, 2400],
    [1280, 2400],
    [1920, 2400],
    [2560, 2400],
  ],
  "Given a long word, Then each letter starts as it is touched and stretches to crest as it is lit"
);
assert.deepEqual(
  waves(400),
  [
    [-240, 900],
    [-160, 900],
    [-80, 900],
    [0, 900],
    [80, 900],
  ],
  "Given a short word, Then each letter starts early enough to crest as it is lit"
);

const ltrSweep = planLetterMaskSweep({ ...SWIPE_RAMP, easing: "ease" }, SWIPE_LETTERS, SWIPE_DURATION_MS, false);
const rtlSweep = planLetterMaskSweep({ ...SWIPE_RAMP, easing: "ease" }, SWIPE_LETTERS, SWIPE_DURATION_MS, true);
assert.ok(
  ltrSweep.some((entry, index) => entry.keyframes[0].maskPosition !== rtlSweep[index].keyframes[0].maskPosition),
  "Given RTL, Then the mask sweeps from the mirrored edge"
);

// Glow alpha parsing: the engine skips a word's per-frame blur only when its resolved glow color
// renders nothing, so this has to read alpha out of every color form a theme might use, and fall
// back to opaque when it cannot, so a visible glow is never dropped.
assert.equal(parseColorAlpha("color(display-p3 1 1 1 / 0.0001)"), 0.0001, "reads slash alpha from color()");
assert.equal(parseColorAlpha("color(display-p3 1 1 1 / 1)"), 1, "reads full slash alpha");
assert.equal(parseColorAlpha("rgb(255 255 255 / 50%)"), 0.5, "reads percentage slash alpha");
assert.equal(parseColorAlpha("rgba(255, 255, 255, 0.0001)"), 0.0001, "reads legacy comma alpha");
assert.equal(parseColorAlpha("hsla(0, 0%, 100%, 0.1)"), 0.1, "reads legacy hsla alpha");
assert.equal(parseColorAlpha("#ffffff80"), 128 / 255, "reads 8-digit hex alpha");
assert.equal(parseColorAlpha("#fff0"), 0, "reads 4-digit hex alpha");
assert.equal(parseColorAlpha("transparent"), 0, "treats transparent as empty");
assert.equal(parseColorAlpha("#ffffff"), 1, "treats hex with no alpha as opaque");
assert.equal(parseColorAlpha("white"), 1, "treats a keyword as opaque");
assert.equal(parseColorAlpha("rgb(255, 255, 255)"), 1, "treats alphaless rgb as opaque");
assert.equal(parseColorAlpha(""), null, "reports nothing for an empty value");
assert.equal(parseColorAlpha("var(--x)"), null, "reports nothing for an unresolved reference");

// Scroll grouping is committed only when a scroll happens. Animation length must not gate it.
{
  const document = new FakeDocument();
  const window = new FakeWindow({ "--blyrics-lyric-scroll-duration": "5000ms", [ANIMATE_SCROLL_PROPERTY]: "1" });
  const host = new FakeHost();
  const mount = document.createElement("div");
  const engine = createAnimationEngineInstance(asDocument(document), asWindow(window), host);
  setLyrics(
    engine,
    asElement<HTMLElement>(mount),
    [
      { startTimeMs: 1000, durationMs: 300, words: "A" },
      { startTimeMs: 1300, durationMs: 500, words: "B" },
      { startTimeMs: 1800, durationMs: 300, words: "C" },
      { startTimeMs: 2100, durationMs: 1000, words: "D" },
    ],
    { loaderVisible: false, noLyrics: false }
  );
  const lines = getRenderedLines(engine);
  lines.forEach((line, index) => {
    line.position = 1000 + index * 200;
    line.height = LINE_HEIGHT_PX;
    Object.defineProperty(line.lyricElement, "isConnected", { value: true });
  });
  const tick = (time: number) => {
    assert.equal(tickView(engine, time, resolveTickOptions(newTickOptions())), "ok");
    assert.deepEqual(host.logs, [], "Scroll ticks must not swallow an exception");
  };
  tick(1);
  assert.ok(!window.propertyReads.includes("--blyrics-lyric-scroll-duration"), "The removed duration is never read");
  const firstPosition = host.scrollElement.scrollTop;
  const firstScrollCount = engine.skipScrolls;
  assert.ok(firstPosition > 0, "The first line must actually scroll");
  assert.deepEqual(engine.lastScrollElements, [lines[0], lines[1]], "A's scroll includes upcoming B");
  assert.equal(engine.cachedAnimationSettings?.scrollTiming.earlyScrollConsiderS, 0.54);
  tick(1.28);
  assert.equal(engine.skipScrolls, firstScrollCount, "C entering lookahead alone must not scroll");
  tick(1.3);
  assert.equal(engine.skipScrolls, firstScrollCount, "B must not scroll again when it starts");
  assert.equal(host.scrollElement.scrollTop, firstPosition, "The committed target remains stationary");
  tick(1.7);
  const previousAnimations = engine.lineScrollAnimations.map(record => record.animation);
  assert.ok(previousAnimations.length > 0, "The previous scroll animations are still running");
  tick(1.8);
  assert.equal(
    engine.skipScrolls,
    firstScrollCount + 1,
    "Ungrouped C scrolls while earlier animations are still running"
  );
  assert.ok(host.scrollElement.scrollTop > firstPosition);
  assert.deepEqual(engine.lastScrollElements, [lines[2], lines[3]], "C's scroll includes upcoming D");
  assert.ok(
    previousAnimations.every(animation => engine.lineScrollAnimations.some(record => record.animation === animation)),
    "A new scroll preserves the previous additive animations"
  );
  tick(2.1);
  assert.equal(engine.skipScrolls, firstScrollCount + 1, "D must not trigger a duplicate scroll");
  tick(1);
  assert.equal(engine.skipScrolls, firstScrollCount + 2, "Seeking backwards must still retarget the viewport");
  engine.destroy();
}

// -- Songwriter credits close the view --------------------------------------------

const creditsDocument = new FakeDocument();
const creditsHost = new FakeHost();
const creditsMount = creditsDocument.createElement("div");
const creditsEngine = createAnimationEngineInstance(
  asDocument(creditsDocument),
  asWindow(new FakeWindow({ [ANIMATE_SCROLL_PROPERTY]: "0" })),
  creditsHost
);

function buildCredits(
  options: { songwriters?: readonly string[]; noLyrics?: boolean },
  lyrics: Lyric[] = LINE_SYNCED_LYRICS
): FakeNode[] {
  setLyrics(creditsEngine, asElement<HTMLElement>(creditsMount), lyrics, {
    loaderVisible: false,
    noLyrics: false,
    ...options,
  });
  return asFakeNode(creditsEngine.lyricsContainer!).childNodes;
}

function creditsIn(children: FakeNode[]): FakeNode[] {
  return children.filter(child => child.classList.contains(CREDITS_CLASS));
}

const creditedChildren = buildCredits({ songwriters: ["Mara Quill", "Jonah Pike", "Ada Stone"] });

assert.ok(
  creditedChildren.at(-1)?.classList.contains(CREDITS_CLASS) && creditedChildren.at(-2)?.classList.contains(LINE_CLASS),
  "Given songwriters, When the lyrics are built, Then the credits come straight after the last line"
);

assert.equal(
  creditedChildren.at(-1)?.textContent,
  "Mara Quill, Jonah Pike & Ada Stone",
  "Given three songwriters, When they are joined, Then commas separate them and an ampersand joins the last two"
);

const creditsText = creditedChildren.at(-1)?.childNodes;
assert.ok(
  creditsText?.length === 1 &&
    creditsText[0].classList.contains(CREDITS_TEXT_CLASS) &&
    creditsText[0].childNodes[0]?.classList.contains(CREDITS_NAMES_CLASS),
  "Given songwriters, When the credits are built, Then the names sit in one inner block so the credits keep the lines' em inset"
);

assert.ok(
  creditedChildren.at(-1)?.name === "p" && creditsText?.[0]?.name === "span",
  "Given songwriters, When the credits are built, Then they are a paragraph rather than a div, so theme rules written for the lines as `.blyrics-container > div` never reach them"
);

assert.equal(
  creditsIn(buildCredits({ songwriters: ["Mara Quill", "Jonah Pike"] }))[0]?.textContent,
  "Mara Quill & Jonah Pike"
);
assert.equal(creditsIn(buildCredits({ songwriters: ["Mara Quill"] }))[0]?.textContent, "Mara Quill");

for (const [label, options] of [
  ["no songwriters", { songwriters: [] }],
  ["songwriters never given", {}],
  ["a placeholder message", { songwriters: ["Mara Quill"], noLyrics: true }],
] as const) {
  assert.equal(
    creditsIn(buildCredits(options)).length,
    0,
    `Given ${label}, When the lyrics are built, Then no credits are built`
  );
}

setThemeSettings(parseThemeConfig("/* blyrics-hide-credits = true; */"));
assert.equal(
  creditsIn(buildCredits({ songwriters: ["Mara Quill"] })).length,
  0,
  "Given a theme that hides the credits, When the lyrics are built, Then no credits are built"
);
setThemeSettings(parseThemeConfig("/* blyrics-hide-credits = false; */"));

// -- The credits take the focus once the last line has ended ------------------------------------

const CREDITS_LINE_HEIGHT_PX = 60;
const CREDITS_GAP_PX = 20;
const CREDITS_TOP_PX = LINE_SYNCED_LYRICS.length * CREDITS_LINE_HEIGHT_PX + CREDITS_GAP_PX;
const CREDITS_HEIGHT_PX = 30;
const TARGET_RATIO = 0.37;

function layOutCredits(creditsHeight: number, lyrics: Lyric[] = LINE_SYNCED_LYRICS): FakeNode {
  const children = buildCredits({ songwriters: ["Mara Quill", "Jonah Pike"] }, lyrics);
  const creditsTop = lyrics.length * CREDITS_LINE_HEIGHT_PX + CREDITS_GAP_PX;
  children
    .filter(child => child.classList.contains(LINE_CLASS))
    .forEach((line, index) => {
      line.offsetTop = index * CREDITS_LINE_HEIGHT_PX;
      line.offsetHeight = CREDITS_LINE_HEIGHT_PX;
    });
  const credits = creditsIn(children)[0];
  credits.offsetTop = creditsTop;
  credits.offsetHeight = creditsHeight;
  const container = asFakeNode(creditsEngine.lyricsContainer!);
  container.scrollHeight = creditsTop + creditsHeight;
  relayout(creditsEngine, true);
  return container;
}

const creditsContainer = layOutCredits(CREDITS_HEIGHT_PX);
const creditsCentre = CREDITS_TOP_PX + CREDITS_HEIGHT_PX / 2;

assert.ok(
  Number.parseFloat(creditsContainer.style.getPropertyValue("padding-bottom")) +
    (creditsContainer.scrollHeight - creditsCentre) >=
    VIEWPORT_HEIGHT_PX * (1 - TARGET_RATIO),
  "Given credits after the last line, When the padding is sized, Then the credits can reach the target scroll position"
);

const LAST_LINE = LINE_SYNCED_LYRICS[LINE_SYNCED_LYRICS.length - 1];
const LAST_LINE_START_S = LAST_LINE.startTimeMs / 1000;
const SONG_ENDED_S = (LAST_LINE.startTimeMs + LAST_LINE.durationMs) / 1000 + 1;
const tickCredits = (timeS: number) => tickView(creditsEngine, timeS, resolveTickOptions(newTickOptions()));

tickCredits(LAST_LINE_START_S);
const lastLineScrollPos = creditsEngine.scrollPos;

assert.equal(
  creditsContainer.dataset.creditsFocused,
  undefined,
  "Given the last line still singing, When the view ticks, Then the credits stay dim"
);

tickCredits(SONG_ENDED_S);

assert.equal(
  creditsContainer.dataset.creditsFocused,
  "true",
  "Given the last line has ended, When the view ticks, Then the credits take the focus"
);

assert.equal(
  creditsEngine.scrollPos,
  creditsCentre - VIEWPORT_HEIGHT_PX * TARGET_RATIO,
  "Given the credits have the focus, When the view scrolls, Then it centres them where a line would sit"
);

tickCredits(LAST_LINE_START_S);

assert.equal(
  creditsContainer.dataset.creditsFocused,
  undefined,
  "Given a seek back into the last line, When the view ticks, Then the credits give the focus back"
);

assert.equal(
  creditsEngine.scrollPos,
  lastLineScrollPos,
  "Given a seek back into the last line, When the view scrolls, Then it aims at that line again"
);

const hiddenCreditsContainer = layOutCredits(0);
tickCredits(SONG_ENDED_S);

assert.equal(
  hiddenCreditsContainer.dataset.creditsFocused,
  undefined,
  "Given credits a stylesheet hid, When the song ends, Then nothing takes the focus"
);

const creditsOutroContainer = layOutCredits(CREDITS_HEIGHT_PX, [
  ...LINE_SYNCED_LYRICS,
  { startTimeMs: LAST_LINE.startTimeMs + LAST_LINE.durationMs, durationMs: 20000, words: "", isInstrumental: true },
]);
tickCredits(SONG_ENDED_S);

assert.equal(
  creditsOutroContainer.dataset.creditsFocused,
  "true",
  "Given an instrumental outro, When the last sung line has ended, Then the credits take the focus without waiting out the outro"
);

const tallCreditsContainer = layOutCredits(VIEWPORT_HEIGHT_PX);
tickCredits(LAST_LINE_START_S);
tickCredits(SONG_ENDED_S);

assert.ok(
  tallCreditsContainer.dataset.creditsFocused === "true" &&
    creditsEngine.scrollPos === (LINE_SYNCED_LYRICS.length - 1) * CREDITS_LINE_HEIGHT_PX,
  "Given credits too tall to centre without scrolling the last line away, When they take the focus, Then the view stops with that line's top still in view"
);

creditsEngine.destroy();

// -- Stage layout --------------------------------------------

class StageHost extends FakeHost {
  scrollElementReads = 0;
  readonly stageBoxes: (StageBox | null)[] = [];

  override getScrollElement(): HTMLElement | null {
    this.scrollElementReads += 1;
    throw new Error("A stage view has no scroll element to ask for");
  }

  onStageLayout(box: StageBox | null): void {
    this.stageBoxes.push(box);
  }
}

const stageDocument = new FakeDocument();
const stageHost = new StageHost(undefined, stageDocument);
const stageMount = stageDocument.createElement("div");
const stageEngine = createAnimationEngineInstance(
  asDocument(stageDocument),
  asWindow(new FakeWindow()),
  stageHost,
  "stage"
);

setLyrics(stageEngine, asElement<HTMLElement>(stageMount), LINE_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
const stageContainer = asFakeNode(stageEngine.lyricsContainer!);
stageContainer.clientHeight = VIEWPORT_HEIGHT_PX;
const stageLines = renderedLineElements(stageMount);
for (const line of stageLines) {
  line.offsetHeight = LINE_HEIGHT_PX;
  line.offsetWidth = 200;
}
relayout(stageEngine, true);

assert.equal(
  stageDocument.documentElement.style.getPropertyValue("--blyrics-padding-top"),
  "",
  "Given a stage view, When it is laid out, Then nothing is written to the document root"
);

const SECOND_LINE_S = LINE_SYNCED_LYRICS[1].startTimeMs / 1000 + 1;
assert.equal(
  tickView(stageEngine, SECOND_LINE_S, resolveTickOptions(newTickOptions())),
  "ok",
  "Given a stage view, When it ticks inside a line, Then it renders"
);

assert.equal(
  stageHost.scrollElementReads,
  0,
  "Given a stage view, When it ticks, Then it never asks for a scroll element"
);

assert.deepEqual(
  stageLines.map(line => line.dataset.stageRole),
  ["gone", "current", "queued"],
  "Given a stage view, When it ticks inside the second line, Then only that line holds the stage"
);

assert.ok(
  stageHost.stageBoxes.length > 0 && stageHost.stageBoxes.at(-1) !== null,
  "Given a stage view with a sung line on stage, When it ticks, Then the host is told where to draw the backdrop"
);

const STAGE_MOVE_EASING = "cubic-bezier(0.2, 0, 0, 1)";
const STAGE_BLUR = "3px";
const stageAnimationCount = (): number => stageLines.reduce((sum, line) => sum + line.animations.length, 0);

assert.deepEqual(
  stageLines.map(line => line.dataset.stageVisible),
  [undefined, "", undefined],
  "Given a stage view, When a line holds the stage, Then only that line is marked visible"
);

const animationsBeforeRepeat = stageAnimationCount();
tickView(stageEngine, SECOND_LINE_S, resolveTickOptions(newTickOptions()));
assert.equal(
  stageAnimationCount(),
  animationsBeforeRepeat,
  "Given a stage view, When it ticks again at the same time, Then no line is animated again"
);

stageContainer.clientHeight = VIEWPORT_HEIGHT_PX + 200;
relayout(stageEngine, true);

for (const time of [
  SECOND_LINE_S + 0.4,
  SECOND_LINE_S + 0.9,
  SECOND_LINE_S + 1.4,
  SECOND_LINE_S + 1.7,
  SECOND_LINE_S + 1.9,
]) {
  tickView(stageEngine, time, resolveTickOptions(newTickOptions()));
}
assert.deepEqual(
  stageLines.map(line => line.dataset.stageRole),
  ["gone", "gone", "current"],
  "Given a stage view, When time advances into the third line, Then the second line leaves the stage"
);
const enteringMove = stageLines[2].animations.findLast(animation => animation.options.easing === STAGE_MOVE_EASING);
const enteringFrom = (enteringMove?.keyframes as Keyframe[] | undefined)?.[0]?.translate;
assert.ok(
  enteringFrom !== undefined && Number.parseFloat(String(enteringFrom).split(" ")[1]) > VIEWPORT_HEIGHT_PX,
  "regression: Given a stage that grew while a line waited, When the line enters, Then it rises from below the new floor, not from where the old size put it"
);
stageContainer.clientHeight = VIEWPORT_HEIGHT_PX;
relayout(stageEngine, true);
tickView(stageEngine, SECOND_LINE_S + 1.9, resolveTickOptions(newTickOptions()));
assert.deepEqual(
  stageLines.map(line => line.dataset.stageVisible),
  [undefined, "", ""],
  "Given a line leaving the stage, When its fade-out has not finished, Then it stays marked visible"
);
const leavingFade = stageLines[1].animations.findLast(animation =>
  (animation.keyframes as Keyframe[]).some(keyframe => "--blyrics-stage-opacity" in keyframe)
)!;
assert.ok(Number(leavingFade.options.duration) > 0, "Given a line leaving on a steady clock, Then it fades out");
assert.ok(
  (leavingFade.keyframes as Keyframe[]).every(
    keyframe => "--blyrics-stage-opacity" in keyframe && !("opacity" in keyframe)
  ),
  "Given a theme that forces opacity with !important, When a line fades, Then the fade drives the stage's own opacity property"
);
const blursOf = (line: (typeof stageLines)[number]) =>
  line.animations.map(animation => (animation.keyframes as Keyframe[]).map(keyframe => keyframe.filter));
const isBlur = (animation: (typeof stageLines)[number]["animations"][number]) =>
  (animation.keyframes as Keyframe[]).some(keyframe => keyframe.filter !== undefined);
const isFade = (animation: (typeof stageLines)[number]["animations"][number]) =>
  (animation.keyframes as Keyframe[]).some(keyframe => "--blyrics-stage-opacity" in keyframe);
assert.ok(
  blursOf(stageLines[1]).some(filters => filters.join() === `none,blur(${STAGE_BLUR})`),
  "Given a line leaving the stage, Then it blurs out as it fades"
);
assert.ok(
  blursOf(stageLines[2]).some(filters => filters.join() === `blur(${STAGE_BLUR}),none`),
  "Given a line entering the stage, Then it blurs in as it fades, so the handoff reads as one morph"
);
const animationCountsBeforeResize = stageLines.map(line => line.animations.length);
const leavingYBeforeResize = stageEngine.stageY.get(asElement<HTMLElement>(stageLines[1]))!;
stageContainer.clientHeight = VIEWPORT_HEIGHT_PX + 200;
relayout(stageEngine, true);
tickView(stageEngine, SECOND_LINE_S + 1.95, resolveTickOptions(newTickOptions()));
assert.equal(
  stageEngine.stageY.get(asElement<HTMLElement>(stageLines[1])),
  leavingYBeforeResize + 200,
  "regression: Given a line still fading out, When the stage grows, Then it moves down with the floor"
);
const resizeAnimations = stageLines.flatMap((line, index) => line.animations.slice(animationCountsBeforeResize[index]));
assert.ok(
  resizeAnimations.length > 0 &&
    resizeAnimations.every(animation => animation.options.duration === 0 && !isFade(animation) && !isBlur(animation)),
  "regression: Given lines mid-transition, When the stage resizes, Then they snap to their new places without sliding"
);
assert.ok(
  [leavingFade, ...stageLines.slice(1).flatMap(line => line.animations.filter(isBlur))].every(
    animation => !animation.cancelled
  ),
  "regression: Given lines mid-transition, When the stage resizes, Then their fades and blurs keep running"
);
stageContainer.clientHeight = VIEWPORT_HEIGHT_PX;
relayout(stageEngine, true);
tickView(stageEngine, SECOND_LINE_S + 1.95, resolveTickOptions(newTickOptions()));
leavingFade.finish();
assert.deepEqual(
  stageLines.map(line => line.dataset.stageVisible),
  [undefined, undefined, ""],
  "Given a finished fade-out, Then the line is no longer marked visible"
);

const leftSlot = stageEngine.stageY.get(asElement<HTMLElement>(stageLines[1]));
tickView(stageEngine, SECOND_LINE_S + 1.55, resolveTickOptions(newTickOptions()));
const returnFrom = (
  stageLines[1].animations.findLast(animation => animation.options.easing === STAGE_MOVE_EASING)?.keyframes as
    | Keyframe[]
    | undefined
)?.[0]?.translate;
assert.equal(stageLines[1].dataset.stageRole, "current", "Given a small rewind, Then the line that just left is back");
assert.equal(
  returnFrom,
  `0 ${leftSlot}px`,
  "regression: Given a small rewind, When the line that just left comes back, Then it returns from its own place, not from below the floor"
);
tickView(stageEngine, SECOND_LINE_S + 1.95, resolveTickOptions(newTickOptions()));

const animationCountsBeforeJump = stageLines.map(line => line.animations.length);
tickView(stageEngine, LINE_SYNCED_LYRICS[0].startTimeMs / 1000 + 1, resolveTickOptions(newTickOptions()));
const jumpedAnimations = stageLines
  .flatMap((line, index) => line.animations.slice(animationCountsBeforeJump[index]))
  .filter(animation => animation.options.fill === "both" || animation.options.easing === STAGE_MOVE_EASING);
assert.ok(
  jumpedAnimations.length > 0 && jumpedAnimations.every(animation => animation.options.duration === 0),
  "Given a stage view, When the clock jumps, Then every line is re-laid with zero-duration animations"
);
assert.deepEqual(
  stageLines.map(line => line.dataset.stageVisible),
  ["", undefined, undefined],
  "Given a seek back to the first line, Then it is the only one marked visible"
);
assert.ok(
  stageLines.flatMap(line => line.animations.filter(isBlur)).every(animation => animation.cancelled),
  "Given a stage view, When the clock jumps, Then no line is left blurring"
);

const staleFadeLine = stageLines[0];
tickView(stageEngine, SECOND_LINE_S, resolveTickOptions(newTickOptions()));
const staleFade = staleFadeLine.animations.findLast(isFade)!;
tickView(stageEngine, LINE_SYNCED_LYRICS[0].startTimeMs / 1000 + 1, resolveTickOptions(newTickOptions()));
staleFade.finish();
assert.equal(
  staleFadeLine.dataset.stageVisible,
  "",
  "Given a fade-out replaced by a fade-in, When the old fade finishes, Then the line stays visible"
);

stageHost.stageBoxes.length = 0;
tickView(stageEngine, SECOND_LINE_S, resolveTickOptions(newTickOptions()));
assert.notEqual(stageHost.stageBoxes.at(-1), null, "Given a sung line on stage, Then a box was reported");
assert.equal(clearOnScreenLyrics(stageEngine), true);
assert.equal(
  stageHost.stageBoxes.at(-1),
  null,
  "Given a stage view, When its lines are taken off the screen, Then the host is told the box is gone"
);
assert.ok(
  stageLines.flatMap(line => line.animations.filter(isBlur)).every(animation => animation.cancelled),
  "Given a stage view, When its lines are taken off the screen, Then no blur is left running"
);

const overlapStageDocument = new FakeDocument();
const overlapStageMount = overlapStageDocument.createElement("div");
const overlapStageEngine = createAnimationEngineInstance(
  asDocument(overlapStageDocument),
  asWindow(new FakeWindow()),
  new StageHost(undefined, overlapStageDocument),
  "stage"
);
setLyrics(
  overlapStageEngine,
  asElement<HTMLElement>(overlapStageMount),
  [
    { startTimeMs: 200000, durationMs: 3000, words: "One" },
    { startTimeMs: 202500, durationMs: 3000, words: "Two" },
  ],
  { loaderVisible: false, noLyrics: false }
);
asFakeNode(overlapStageEngine.lyricsContainer!).clientHeight = VIEWPORT_HEIGHT_PX;
const overlapStageLines = renderedLineElements(overlapStageMount);
for (const line of overlapStageLines) {
  line.offsetHeight = LINE_HEIGHT_PX;
  line.offsetWidth = 200;
}
relayout(overlapStageEngine, true);
for (const time of [200.2, 200.6, 201, 201.4, 201.8]) {
  tickView(overlapStageEngine, time, resolveTickOptions(newTickOptions()));
}
const sungLineBlurs = overlapStageLines[0].animations.filter(isBlur).length;
asFakeNode(overlapStageEngine.lyricsContainer!).clientHeight = VIEWPORT_HEIGHT_PX + 200;
relayout(overlapStageEngine, true);
tickView(overlapStageEngine, 202.1, resolveTickOptions(newTickOptions()));
assert.deepEqual(
  overlapStageLines.map(line => line.dataset.stageRole),
  ["previous", "current"]
);
assert.ok(
  Number(
    overlapStageLines[0].animations.findLast(animation => animation.options.easing === STAGE_MOVE_EASING)?.options
      .duration
  ) > 0,
  "regression: Given a resize in the same pass as an overlap, When a line is pushed up, Then it still slides up rather than jumping"
);
assert.equal(
  overlapStageLines[0].animations.filter(isBlur).length,
  sungLineBlurs,
  "regression: a line still being sung, When an overlapping line pushes it up, Then it stays in focus"
);

setLyrics(stageEngine, asElement<HTMLElement>(stageMount), LINE_SYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
for (const line of renderedLineElements(stageMount)) {
  line.offsetHeight = LINE_HEIGHT_PX;
  line.offsetWidth = 200;
}
asFakeNode(stageEngine.lyricsContainer!).clientHeight = VIEWPORT_HEIGHT_PX;
relayout(stageEngine, true);
stageHost.stageBoxes.length = 0;
tickView(stageEngine, SECOND_LINE_S, resolveTickOptions(newTickOptions()));
assert.notEqual(stageHost.stageBoxes.at(-1), null, "Given a rebuilt stage view, Then a box was reported again");
clearLyrics(stageEngine);
assert.equal(
  stageHost.stageBoxes.at(-1),
  null,
  "Given a stage view, When the song is cleared, Then the host is told the box is gone"
);

stageEngine.destroy();

const unsyncedDocument = new FakeDocument();
const unsyncedHost = new StageHost(undefined, unsyncedDocument);
const unsyncedMount = unsyncedDocument.createElement("div");
const unsyncedEngine = createAnimationEngineInstance(
  asDocument(unsyncedDocument),
  asWindow(new FakeWindow()),
  unsyncedHost,
  "stage"
);
setLyrics(unsyncedEngine, asElement<HTMLElement>(unsyncedMount), UNSYNCED_LYRICS, {
  loaderVisible: false,
  noLyrics: false,
});
assert.equal(
  tickView(unsyncedEngine, 5, resolveTickOptions({ ...newTickOptions(), passiveScrollEnabled: true })),
  "ok",
  "Given a stage view with unsynced lyrics and passive scrolling on, When it ticks, Then it renders nothing"
);
assert.equal(
  unsyncedHost.scrollElementReads,
  0,
  "Given a stage view with unsynced lyrics, When passive scrolling is on, Then no scroll element is asked for"
);
unsyncedEngine.destroy();

const duetDocument = new FakeDocument();
const duetMount = duetDocument.createElement("div");
const duetEngine = createAnimationEngineInstance(
  asDocument(duetDocument),
  asWindow(new FakeWindow()),
  new StageHost(undefined, duetDocument),
  "stage"
);
setLyrics(duetEngine, asElement<HTMLElement>(duetMount), LINE_SYNCED_LYRICS, { loaderVisible: false, noLyrics: false });
assert.equal(
  duetEngine.lyricsContainer!.dataset.stageDuet,
  undefined,
  "Given a stage view of one singer, Then its lines stay centred"
);
setLyrics(
  duetEngine,
  asElement<HTMLElement>(duetMount),
  LINE_SYNCED_LYRICS.map((lyric, index) => ({ ...lyric, agent: index % 2 === 0 ? "v1" : "v2" })),
  { loaderVisible: false, noLyrics: false }
);
assert.equal(
  duetEngine.lyricsContainer!.dataset.stageDuet,
  "",
  "Given a stage view of a duet, Then the container is marked so each singer takes a side"
);
setLyrics(
  duetEngine,
  asElement<HTMLElement>(duetMount),
  LINE_SYNCED_LYRICS.map((lyric, index) => ({ ...lyric, agent: index === 1 ? "v1000" : "v2" })),
  { loaderVisible: false, noLyrics: false }
);
assert.equal(
  duetEngine.lyricsContainer!.dataset.stageDuet,
  undefined,
  "regression: Given a stage view whose only singer is v2, Then its lines stay centred rather than on one side"
);

const blankDocument = new FakeDocument();
const blankHost = new StageHost(undefined, blankDocument);
const blankMount = blankDocument.createElement("div");
const blankEngine = createAnimationEngineInstance(
  asDocument(blankDocument),
  asWindow(new FakeWindow()),
  blankHost,
  "stage"
);
setLyrics(
  blankEngine,
  asElement<HTMLElement>(blankMount),
  LINE_SYNCED_LYRICS.map((lyric, index) => (index === 1 ? { ...lyric, words: "" } : lyric)),
  { loaderVisible: false, noLyrics: false }
);
asFakeNode(blankEngine.lyricsContainer!).clientHeight = VIEWPORT_HEIGHT_PX;
for (const line of renderedLineElements(blankMount)) {
  line.offsetHeight = LINE_HEIGHT_PX;
  line.offsetWidth = 200;
}
relayout(blankEngine, true);
for (const time of [201, 202, 203.5, 204.5]) tickView(blankEngine, time, resolveTickOptions(newTickOptions()));
assert.deepEqual(
  renderedLineElements(blankMount).map(line => line.dataset.stageRole),
  ["gone", "current", "queued"],
  "Given a blank line, Then it takes the stage from the line before it"
);
assert.equal(
  blankHost.stageBoxes.at(-1),
  null,
  "regression: Given a blank line on the stage, Then the host is told there is nothing to draw a backdrop behind"
);
blankEngine.destroy();

console.log(
  `Renderer engine self-check passed across ${viewNames.size} instance(s) over ` +
    `${panelDocument.calls.length + floatingDocument.calls.length} built node(s)`
);

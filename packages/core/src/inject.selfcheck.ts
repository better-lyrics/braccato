import { strict as assert } from "node:assert";
import {
  BACKGROUND_LINE_CLASS,
  BACKGROUND_LYRIC_CLASS,
  BIDI_RUN_CLASS,
  HIGHLIGHT_RUN_CLASS,
  LETTER_CLASS,
  LINE_MAIN_CLASS,
  LYRICS_CLASS,
  ROMANIZED_LYRICS_CLASS,
  TRANSLATED_LYRICS_CLASS,
  WORD_CLASS,
  WORD_GROUP_CLASS,
  WORD_HIGHLIGHT_CLASS,
  WORD_HIGHLIGHT_LETTERED_CLASS,
} from "./constants";
import { addSeekHandler, createLyricsLine, injectRomanization, injectTranslation, newLineData } from "./inject";
import { createInstrumentalElement } from "./instrumental";
import { asDocument, asElement, collectTree, FakeDocument, type FactoryName, type FakeNode } from "./selfcheck/fakeDom";
import { setThemeSettings } from "./themeSettings";
import type { LyricPart } from "./types";

// The builder takes the document to build into, so two instances can render into two documents.
// Nothing else stops an edit from typing document.createElement instead of doc.createElement: both
// typecheck, both lint, and in a browser both succeed, leaving the floating window rendering nothing
// while the side panel looks fine. Here the tree is walked back to the document that made it, and the
// ambient global document is poisoned so reaching for it fails loudly instead of quietly working.

// -- Ambient document poison --------------------------------------------

let ambientDocumentReads = 0;

Object.defineProperty(globalThis, "document", {
  configurable: true,
  get(): never {
    ambientDocumentReads += 1;
    throw new Error("The renderer read the ambient global document instead of the one it was handed");
  },
});

// -- Fixtures --------------------------------------------

const FACTORY_NAMES: FactoryName[] = ["createElement", "createElementNS", "createTextNode"];

function findForeignNodes(root: FakeNode, owner: FakeDocument): string[] {
  return collectTree(root)
    .filter(node => node.ownerDocument !== owner)
    .map(node => node.name);
}

// -- Every node comes from the injected document --------------------------------------------

const doc = new FakeDocument();
const buildDocument = asDocument(doc);

const lyricElement = doc.createElement("div");
lyricElement.dataset.time = "12.5";
const buildTarget = asElement<HTMLElement>(lyricElement);

// "indistinguishable" is past the long word wrap threshold, which drives the wbr path; "world" is
// a background part, which drives the second line.
const parts: LyricPart[] = [
  { startTimeMs: 0, words: "Hello ", durationMs: 400 },
  { startTimeMs: 400, words: "indistinguishable ", durationMs: 900 },
  { startTimeMs: 1300, words: "world", durationMs: 300, isBackground: true },
];

// Letter wave and the wrap-break path are mutually exclusive branches, so this fixture opts out to
// exercise the wbr wrapping it asserts below.
setThemeSettings(new Map([["blyrics-letter-wave", "false"]]));

const lineData = newLineData(buildTarget, 0, 1600);
createLyricsLine(buildDocument, parts, lineData, buildTarget);
injectRomanization(buildDocument, buildTarget, lineData, "sekai");
injectRomanization(buildDocument, buildTarget, lineData, "sekai");
injectTranslation(buildDocument, buildTarget, "world");
injectTranslation(buildDocument, buildTarget, "world");

const instrumental = doc.createElement("div");
createInstrumentalElement(buildDocument, asElement<HTMLDivElement>(instrumental), 3000, 4);

const unusedFactories = FACTORY_NAMES.filter(factory => doc.countOf(factory) === 0);
assert.deepEqual(
  unusedFactories,
  [],
  "Given a built line and instrumental, When the fake is measured, Then every node factory the builder needs ran on it"
);

assert.equal(
  lineData.parts.length,
  3,
  "Given three timed parts, When the line is built, Then each one leaves a part record behind"
);

const builtNodes = collectTree(lyricElement);

assert.deepEqual(
  builtNodes
    .filter(node => node.classList.contains(WORD_CLASS) && !node.classList.contains(WORD_HIGHLIGHT_CLASS))
    .map(node => node.dataset.content),
  ["Hello", "indistinguishable", "world"],
  "Given a line with a background part, When it is built, Then every word is rendered once"
);

assert.ok(
  builtNodes.some(node => node.name === "wbr"),
  "Given a word past the wrap threshold, When it is built, Then its break nodes come from the injected document"
);

const wrappedWord = builtNodes.find(
  node =>
    node.classList.contains(WORD_CLASS) &&
    !node.classList.contains(WORD_HIGHLIGHT_CLASS) &&
    node.dataset.content === "indistinguishable"
);
const highlights = builtNodes.filter(node => node.classList.contains(WORD_HIGHLIGHT_CLASS));
const wrappedHighlight = highlights.find(node => node.dataset.content === "indistinguishable");

assert.equal(
  highlights.length,
  3,
  "Given three timed words, When the line is built, Then every word has the same real highlight target"
);
assert.equal(
  highlights.some(node => node.classList.contains(WORD_HIGHLIGHT_LETTERED_CLASS)),
  false,
  "Given letter wave off, When a highlight word is built, Then it stays unlettered and keeps its swipe gradient"
);
assert.ok(
  wrappedHighlight?.parentNode?.classList.contains(WORD_GROUP_CLASS),
  "Given a wrapping highlight, When it is built, Then its matching highlight group owns it"
);
assert.ok(
  wrappedHighlight?.parentNode?.parentNode?.classList.contains(HIGHLIGHT_RUN_CLASS),
  "Given a timed word, When it is built, Then its highlight participates in the shared highlight run"
);
assert.equal(
  lineData.parts[1].highlightElement,
  wrappedHighlight,
  "Given a timed word, When animation data is built, Then it retains its real highlight target"
);
assert.equal(
  wrappedWord?.textContent,
  wrappedHighlight?.textContent,
  "Given a wrapping word, When both runs are built, Then the visible and highlighted text are identical"
);
assert.deepEqual(
  lineData.parts.map(part => part.highlightElement.dataset.content),
  lineData.parts.map(part => part.lyricElement.dataset.content),
  "Given a timed line, When both runs are built, Then every highlight maps to the same word content"
);

assert.deepEqual(
  builtNodes.filter(node => node.classList.contains(ROMANIZED_LYRICS_CLASS)).length,
  1,
  "Given romanization injected twice, When the line is walked, Then only one romanized line exists"
);

assert.deepEqual(
  builtNodes.filter(node => node.classList.contains(TRANSLATED_LYRICS_CLASS)).length,
  1,
  "Given a translation injected twice, When the line is walked, Then only one translated line exists"
);

assert.deepEqual(
  findForeignNodes(lyricElement, doc),
  [],
  "Given a built line, When the tree is walked, Then every node belongs to the injected document"
);

assert.deepEqual(
  findForeignNodes(instrumental, doc),
  [],
  "Given a built instrumental line, When the tree is walked, Then every node belongs to the injected document"
);

assert.deepEqual(
  [...new Set(doc.calls.filter(call => call.factory === "createElementNS").map(call => call.namespace))],
  ["http://www.w3.org/2000/svg"],
  "Given an instrumental line, When its icon is built, Then every namespaced node is svg"
);

// The walk above is what catches a second document in a browser, where both documents answer
// createElement. This fixture proves the walk reports a stranger rather than always returning [].
const mixedRoot = doc.createElement("div");
mixedRoot.appendChild(new FakeDocument().createElement("span"));
assert.deepEqual(
  findForeignNodes(mixedRoot, doc),
  ["span"],
  "Given a node built in another document, When the tree is walked, Then it is reported"
);

assert.equal(
  ambientDocumentReads,
  0,
  "Given a full build, When it finishes, Then the ambient global document was never read"
);

// -- Letter wave is on by default and splits a word into letters --------------------------------------------

setThemeSettings(new Map([["blyrics-letter-wave", "true"]]));

const waveDoc = new FakeDocument();
const waveElement = waveDoc.createElement("div");
const waveTarget = asElement<HTMLElement>(waveElement);
const waveLine = newLineData(waveTarget, 0, 400);
createLyricsLine(asDocument(waveDoc), [{ startTimeMs: 0, words: "Hi", durationMs: 400 }], waveLine, waveTarget);

const waveNodes = collectTree(waveElement);
const waveWord = waveNodes.find(
  node => node.classList.contains(WORD_CLASS) && !node.classList.contains(WORD_HIGHLIGHT_CLASS)
);
assert.deepEqual(
  waveNodes
    .filter(node => node.classList.contains(LETTER_CLASS) && node.parentNode === waveWord)
    .map(node => node.textContent),
  ["H", "i"],
  "Given letter wave on by default, When a word is built, Then it splits into ordered per-letter spans"
);
assert.equal(
  waveNodes.some(node => node.name === "wbr"),
  false,
  "Given letter wave on, When a word is built, Then the wrap-break path does not also run"
);

const waveHighlights = waveNodes.filter(node => node.classList.contains(WORD_HIGHLIGHT_CLASS));
assert.ok(
  waveHighlights.length > 0 && waveHighlights.every(node => node.classList.contains(WORD_HIGHLIGHT_LETTERED_CLASS)),
  "Given letter wave on, When a highlight word is split into letters, Then it carries the lettered class the swipe-off rule selects"
);
assert.equal(
  waveNodes.some(
    node => node.classList.contains(WORD_HIGHLIGHT_LETTERED_CLASS) && !node.classList.contains(WORD_HIGHLIGHT_CLASS)
  ),
  false,
  "Given letter wave on, When words are built, Then the lettered class marks only the highlight run"
);

function lettersOf(words: string): string[] {
  const localDoc = new FakeDocument();
  const root = localDoc.createElement("div");
  const target = asElement<HTMLElement>(root);
  const line = newLineData(target, 0, 400);
  createLyricsLine(asDocument(localDoc), [{ startTimeMs: 0, words, durationMs: 400 }], line, target);
  const nodes = collectTree(root);
  const word = nodes.find(
    node => node.classList.contains(WORD_CLASS) && !node.classList.contains(WORD_HIGHLIGHT_CLASS)
  );
  return nodes
    .filter(node => node.classList.contains(LETTER_CLASS) && node.parentNode === word)
    .map(node => node.textContent);
}

assert.deepEqual(
  lettersOf("मैं"),
  ["मैं"],
  "Given a Devanagari word, When letter wave splits it, Then a consonant and its matras stay one grapheme span"
);
assert.deepEqual(
  lettersOf("আমি"),
  ["আ", "মি"],
  "Given a Bengali word, When letter wave splits it, Then each consonant keeps its vowel sign in one span"
);
assert.deepEqual(
  lettersOf("👨‍👩‍👧"),
  ["👨‍👩‍👧"],
  "Given a ZWJ emoji sequence, When letter wave splits it, Then it stays one grapheme span"
);

setThemeSettings(new Map());

// -- A line click calls seek, not a document --------------------------------------------

const seeks: number[] = [];
addSeekHandler(timeS => seeks.push(timeS), buildTarget, false);

assert.equal(
  lyricElement.clickListeners.length,
  1,
  "Given a timed line, When a seek handler is added, Then it listens for clicks"
);

const untimed = doc.createElement("div");
addSeekHandler(() => assert.fail("An untimed line must not seek"), asElement<HTMLElement>(untimed), true);

assert.equal(
  untimed.clickListeners.length,
  0,
  "Given a line with no timing, When a seek handler is added, Then nothing listens for clicks"
);

assert.equal(
  untimed.style.cursor,
  "unset",
  "Given a line with no timing, When a seek handler is added, Then the pointer stops inviting a click"
);

const richsyncContainer = doc.createElement("div");
richsyncContainer.classList.add(LYRICS_CLASS);
richsyncContainer.dataset.sync = "richsync";
richsyncContainer.appendChild(lyricElement);

const backgroundWord = builtNodes.find(
  node =>
    node.classList.contains(WORD_CLASS) &&
    !node.classList.contains(WORD_HIGHLIGHT_CLASS) &&
    node.dataset.content === "world"
);
assert.ok(backgroundWord !== undefined, "Given a built line, When a word is looked up, Then the fixture holds it");

const callsBeforeClicks = doc.calls.length;

lyricElement.dispatchClick({ target: lyricElement, altKey: false, clientX: 0, clientY: 0 });
assert.deepEqual(
  seeks,
  [12.5],
  "Given a plain click on a timed line, When the handler runs, Then seek receives the line time in seconds"
);

lyricElement.dispatchClick({ target: backgroundWord, altKey: true, clientX: 0, clientY: 0 });
assert.deepEqual(
  seeks,
  [12.5, 1.3],
  "Given an alt click on a word of a rich synced line, When the handler runs, Then seek receives that word's time"
);

assert.equal(
  doc.calls.length,
  callsBeforeClicks,
  "Given a click, When seek runs, Then it builds no nodes in any document"
);

assert.equal(
  ambientDocumentReads,
  0,
  "Given a build and two clicks, When both finish, Then the ambient global document was never read"
);

// -- Background word spacing --------------------------------------------

function buildSpacingLine(
  parts: LyricPart[],
  options?: { splitBackgroundLine: boolean }
): { root: FakeNode; line: ReturnType<typeof newLineData> } {
  const localDoc = new FakeDocument();
  const root = localDoc.createElement("div");
  const target = asElement<HTMLElement>(root);
  const line = newLineData(target, 0, 2000);
  createLyricsLine(asDocument(localDoc), parts, line, target, options);
  return { root, line };
}

const isBlank = (node: FakeNode): boolean => node.textContent.length > 0 && node.textContent.trim() === "";
const backgroundLineOf = (root: FakeNode): FakeNode | undefined =>
  collectTree(root).find(node => node.classList.contains(BACKGROUND_LINE_CLASS));
const wrappedSpacesIn = (root: FakeNode): FakeNode[] =>
  collectTree(root).filter(
    node => node.name === "span" && node.classList.contains(BACKGROUND_LYRIC_CLASS) && isBlank(node)
  );
const bareSpacesIn = (root: FakeNode): FakeNode[] =>
  collectTree(root).filter(node => node.kind === "text" && isBlank(node));

// Happy path: one gap between two background words, wrapped in the content run and its highlight run.
{
  const { root } = buildSpacingLine([
    { startTimeMs: 0, words: "main phrase", durationMs: 400 },
    { startTimeMs: 800, words: "back vocal", durationMs: 400, isBackground: true },
  ]);
  const backgroundLine = backgroundLineOf(root);
  assert.ok(
    backgroundLine !== undefined,
    "Given a background part, When the line is built, Then it has a background line"
  );
  assert.equal(
    wrappedSpacesIn(backgroundLine).length,
    2,
    "Given two background words, When the line is built, Then the gap is a sized span in the content run and its highlight run"
  );
  assert.equal(
    bareSpacesIn(backgroundLine).length,
    0,
    "Given a background run, When it is built, Then no whitespace is left as a full-size bare text node"
  );

  const mainLine = collectTree(root).find(node => node.classList.contains(LINE_MAIN_CLASS));
  assert.ok(
    mainLine !== undefined && bareSpacesIn(mainLine).length >= 1,
    "Given a main run, When it is built, Then its word spacing stays a bare text node at the full line size"
  );
  assert.equal(
    wrappedSpacesIn(mainLine).length,
    0,
    "Given a main run, When it is built, Then none of its spacing is wrapped in the background size"
  );
}

// Count and symmetry: three background words leave two gaps, mirrored across both runs.
{
  const { root } = buildSpacingLine([
    { startTimeMs: 0, words: "hold", durationMs: 200 },
    { startTimeMs: 200, words: "the line here", durationMs: 600, isBackground: true },
  ]);
  const backgroundLine = backgroundLineOf(root);
  assert.ok(
    backgroundLine !== undefined,
    "Given three background words, When the line is built, Then it has a background line"
  );
  const contentRun = collectTree(backgroundLine).find(
    node => node.classList.contains(BIDI_RUN_CLASS) && !node.classList.contains(HIGHLIGHT_RUN_CLASS)
  );
  const highlightRun = collectTree(backgroundLine).find(node => node.classList.contains(HIGHLIGHT_RUN_CLASS));
  assert.ok(
    contentRun !== undefined && highlightRun !== undefined,
    "Given a background line, When built, Then it holds a content run and a highlight run"
  );
  assert.equal(
    wrappedSpacesIn(contentRun).length,
    2,
    "Given three background words, When built, Then the content run has one sized span per gap"
  );
  assert.equal(
    wrappedSpacesIn(highlightRun).length,
    wrappedSpacesIn(contentRun).length,
    "Given a background line, When built, Then the highlight run mirrors the content run's spacing exactly"
  );
}

// Edge: a single background word has no gap, so nothing is wrapped and nothing is left bare either.
{
  const { root } = buildSpacingLine([
    { startTimeMs: 0, words: "lead", durationMs: 200 },
    { startTimeMs: 200, words: "solo", durationMs: 200, isBackground: true },
  ]);
  const backgroundLine = backgroundLineOf(root);
  assert.ok(
    backgroundLine !== undefined,
    "Given a single background word, When the line is built, Then it still has a background line"
  );
  assert.equal(
    wrappedSpacesIn(backgroundLine).length,
    0,
    "Given a single background word, When built, Then there is no gap to size"
  );
  assert.equal(
    bareSpacesIn(backgroundLine).length,
    0,
    "Given a single background word, When built, Then no leading space is emitted before it"
  );
}

// Regression: the wrapped space stays real whitespace, so the browser still collapses and trims it at a wrap.
{
  const { root } = buildSpacingLine([
    { startTimeMs: 0, words: "x", durationMs: 100 },
    { startTimeMs: 100, words: "back   vocal", durationMs: 400, isBackground: true },
  ]);
  const spaces = wrappedSpacesIn(backgroundLineOf(root) as FakeNode);
  assert.ok(spaces.length > 0, "Given a background gap, When built, Then it is a wrapped span");
  assert.ok(
    spaces.every(node => node.textContent === "   "),
    "Given a multi-space background gap, When built, Then the wrapped span holds the source whitespace verbatim, not a margin"
  );
}

// Invariants: the wrapped space is a plain sizing node, no word, timing or direction, so nothing animates it.
{
  const { root, line } = buildSpacingLine([{ startTimeMs: 0, words: "one two", durationMs: 400, isBackground: true }]);
  const spaces = wrappedSpacesIn(backgroundLineOf(root) as FakeNode);
  assert.ok(spaces.length > 0, "Given a background gap, When built, Then it is a wrapped span");
  assert.ok(
    spaces.every(
      node =>
        !node.classList.contains(WORD_CLASS) &&
        !node.classList.contains(WORD_GROUP_CLASS) &&
        !node.classList.contains(WORD_HIGHLIGHT_CLASS)
    ),
    "Given a wrapped space, When built, Then it is neither a word, a word group, nor a highlight"
  );
  assert.ok(
    spaces.every(
      node =>
        node.dataset.time === undefined && node.dataset.duration === undefined && node.dataset.content === undefined
    ),
    "Given a wrapped space, When built, Then it carries none of the timing a word does"
  );
  assert.ok(
    spaces.every(node => node.dir === ""),
    "Given a wrapped space, When built, Then it sets no direction and cannot open a bidi isolate"
  );
  assert.equal(
    line.parts.length,
    2,
    "Given two background words split by a space, When built, Then only the words become parts and the space adds none"
  );
  assert.equal(
    collectTree(root).filter(node => node.classList.contains(WORD_HIGHLIGHT_CLASS)).length,
    2,
    "Given two background words, When built, Then there is one highlight target per word and none for the space"
  );
}

// Inline background (unsplit line): the words share the main run, so their spacing stays a bare text node.
{
  const { root } = buildSpacingLine(
    [
      { startTimeMs: 0, words: "romanized", durationMs: 200 },
      { startTimeMs: 200, words: "echo here", durationMs: 400, isBackground: true },
    ],
    { splitBackgroundLine: false }
  );
  assert.equal(
    backgroundLineOf(root),
    undefined,
    "Given an unsplit line, When built, Then no separate background line is created"
  );
  assert.equal(
    wrappedSpacesIn(root).length,
    0,
    "Given inline background words, When built, Then their spacing is not wrapped in the background size"
  );
  assert.ok(
    bareSpacesIn(root).length >= 1,
    "Given inline background words, When built, Then their spacing stays a bare text node in the shared run"
  );
}

// Bidi: an RTL background gap is a directionless span, so the run ordering matches the old bare text node.
{
  const { root } = buildSpacingLine([{ startTimeMs: 0, words: "مرحبا صديقي", durationMs: 400, isBackground: true }]);
  const spaces = wrappedSpacesIn(backgroundLineOf(root) as FakeNode);
  assert.ok(
    spaces.length > 0 && spaces.every(node => node.dir === ""),
    "Given an RTL background gap, When built, Then it is a directionless wrapped span"
  );
}

// -- Decorators keep a fixed order no matter which lands first --------------------------------------------
{
  const orderOf = (first: "romanization" | "translation"): { romanization: number; translation: number } => {
    const localDoc = new FakeDocument();
    const root = localDoc.createElement("div");
    const target = asElement<HTMLElement>(root);
    const line = newLineData(target, 0, 400);
    const romanize = () => injectRomanization(asDocument(localDoc), target, line, "sekai");
    const translate = () => injectTranslation(asDocument(localDoc), target, "world");
    if (first === "translation") {
      translate();
      romanize();
    } else {
      romanize();
      translate();
    }
    const decorators = collectTree(root).filter(
      node => node.classList.contains(ROMANIZED_LYRICS_CLASS) || node.classList.contains(TRANSLATED_LYRICS_CLASS)
    );
    return {
      romanization: decorators.findIndex(node => node.classList.contains(ROMANIZED_LYRICS_CLASS)),
      translation: decorators.findIndex(node => node.classList.contains(TRANSLATED_LYRICS_CLASS)),
    };
  };

  const romanizationFirst = orderOf("romanization");
  assert.ok(
    romanizationFirst.romanization < romanizationFirst.translation,
    "Given romanization injected before translation, When both are placed, Then romanization sits above translation"
  );

  const translationFirst = orderOf("translation");
  assert.ok(
    translationFirst.romanization < translationFirst.translation,
    "Given translation injected before romanization, When both are placed, Then romanization still sits above translation"
  );
}

console.log(`Renderer builder self-check passed across ${doc.calls.length} built node(s)`);

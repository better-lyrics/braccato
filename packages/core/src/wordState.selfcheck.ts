import { strict as assert } from "node:assert";
import { WORD_STATE_ACTIVE, WORD_STATE_ATTR, WORD_STATE_PAST, WORD_STATE_UPCOMING } from "./constants";
import { updateWordStates } from "./engine";
import { createLyricsLine, type LineData, newLineData } from "./inject";
import { asDocument, asElement, asFakeNode, FakeDocument } from "./selfcheck/fakeDom";
import type { LyricPart } from "./types";

const doc = new FakeDocument();
const document = asDocument(doc);

function buildLine(parts: LyricPart[], durationMs: number): LineData {
  const target = asElement<HTMLElement>(doc.createElement("div"));
  const lineData = newLineData(target, parts[0].startTimeMs, durationMs);
  createLyricsLine(document, parts, lineData, target);
  return lineData;
}

function stateOf(lineData: LineData, index: number): { base: string; highlight: string } {
  const part = lineData.parts[index];
  return {
    base: asFakeNode(part.lyricElement).attributes[WORD_STATE_ATTR],
    highlight: asFakeNode(part.highlightElement).attributes[WORD_STATE_ATTR],
  };
}

function assertState(lineData: LineData, index: number, expected: string, when: string): void {
  const { base, highlight } = stateOf(lineData, index);
  assert.equal(base, expected, `Given ${when}, When the base word is read, Then it is ${expected}`);
  assert.equal(highlight, expected, `Given ${when}, When the highlight overlay is read, Then it is ${expected}`);
}

const richLine = buildLine(
  [
    { startTimeMs: 0, words: "Hello ", durationMs: 400 },
    { startTimeMs: 400, words: "world", durationMs: 600 },
  ],
  1000
);

assertState(richLine, 0, WORD_STATE_UPCOMING, "a freshly built word");
assertState(richLine, 1, WORD_STATE_UPCOMING, "a freshly built word");

updateWordStates(richLine, 0.2);
assertState(richLine, 0, WORD_STATE_ACTIVE, "the clock inside the first word's window");
assertState(richLine, 1, WORD_STATE_UPCOMING, "the clock before the second word starts");

updateWordStates(richLine, 0.5);
assertState(richLine, 0, WORD_STATE_PAST, "the clock past the first word's end");
assertState(richLine, 1, WORD_STATE_ACTIVE, "the clock inside the second word's window");

updateWordStates(richLine, 1.2);
assertState(richLine, 0, WORD_STATE_PAST, "the clock past the whole line");
assertState(richLine, 1, WORD_STATE_PAST, "the clock past the whole line");

const lineSynced = buildLine(
  [
    { startTimeMs: 0, words: "One ", durationMs: 0 },
    { startTimeMs: 100, words: "Two ", durationMs: 0 },
    { startTimeMs: 200, words: "Three", durationMs: 0 },
  ],
  1000
);

updateWordStates(lineSynced, 0.05);
assertState(lineSynced, 0, WORD_STATE_ACTIVE, "a zero duration word inside its span up to the next word");
assertState(lineSynced, 1, WORD_STATE_UPCOMING, "a zero duration word not yet reached");

updateWordStates(lineSynced, 0.15);
assertState(lineSynced, 0, WORD_STATE_PAST, "a zero duration word once the next word has started");
assertState(lineSynced, 1, WORD_STATE_ACTIVE, "a zero duration word inside its span up to the next word");

updateWordStates(lineSynced, 0.5);
assertState(lineSynced, 2, WORD_STATE_ACTIVE, "the last zero duration word between its start and the line end");

updateWordStates(lineSynced, 1.5);
assertState(lineSynced, 2, WORD_STATE_PAST, "the last zero duration word past the line end");

updateWordStates(richLine, 0.2);
asFakeNode(richLine.parts[0].lyricElement).setAttribute(WORD_STATE_ATTR, "tampered");
updateWordStates(richLine, 0.2);
assert.equal(
  asFakeNode(richLine.parts[0].lyricElement).attributes[WORD_STATE_ATTR],
  "tampered",
  "Given a word whose state has not changed since the last tick, When the tick runs again, Then it does not touch the DOM"
);

updateWordStates(richLine, 0.5);
assert.equal(
  asFakeNode(richLine.parts[0].lyricElement).attributes[WORD_STATE_ATTR],
  WORD_STATE_PAST,
  "Given a word whose state has changed, When the tick runs, Then it writes the new state"
);

console.log("word-state self-check passed");

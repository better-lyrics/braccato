import { strict as assert } from "node:assert";
import { LINE_CLASS, ROMANIZED_LYRICS_CLASS, TRANSLATED_LYRICS_CLASS } from "./constants";
import { injectRomanization, injectTranslation, type LineData } from "./inject";
import { createLyricsRenderer } from "./renderer";
import { asDocument, asElement, asFakeAnimation, asFakeNode, FakeDocument, type FakeNode } from "./selfcheck/fakeDom";
import { asWindow, FakeWindow, installFakeDOMRect } from "./selfcheck/fakeWindow";
import type { Lyric, LyricsRenderer } from "./types";

// A song given to a view that already shows one is swapped into it. Everything here is about what a
// reader would see across that swap: the lines both songs share, and where the view is, stay put.

installFakeDOMRect();

const VIEWPORT_HEIGHT_PX = 600;
const LINE_PITCH_PX = 200;
const LINE_HEIGHT_PX = 100;
// Inside the second line, so the second line is the one the view follows.
const PLAYBACK_TIME_S = 6;
const ELAPSED_SINCE_START_MS = 1000;

class SwapDocument extends FakeDocument {
  readonly fonts = { ready: new Promise<void>(() => {}) };
  readonly documentElement = this.createElement("html");
  readonly visibilityState = "visible";
}

function song(...words: string[]): Lyric[] {
  return words.map((text, index) => ({ startTimeMs: index * 5000, durationMs: 5000, words: text }));
}

const FIRST_SONG = ["First line", "Second line", "Third line", "Fourth line"];

interface Fixture {
  renderer: LyricsRenderer;
  scrollContainer: FakeNode;
  mount: FakeNode;
  document: SwapDocument;
  resumeAffordanceCalls: boolean[];
}

function newFixture(layout: "scroll" | "stage" = "scroll"): Fixture {
  const document = new SwapDocument();
  const window = new FakeWindow({ "--blyrics-animate-scroll": "0" });
  const scrollContainer = document.createElement("div");
  const mount = document.createElement("div");
  scrollContainer.offsetHeight = VIEWPORT_HEIGHT_PX;
  scrollContainer.clientHeight = VIEWPORT_HEIGHT_PX;
  scrollContainer.scrollHeight = VIEWPORT_HEIGHT_PX * 100;
  scrollContainer.appendChild(mount);
  window.overflowByElement.set(scrollContainer, "auto");
  const resumeAffordanceCalls: boolean[] = [];
  const renderer = createLyricsRenderer({
    document: asDocument(document),
    window: asWindow(window),
    mount: asElement<HTMLElement>(mount),
    layout,
    host: {
      setResumeAffordanceVisible: visible => resumeAffordanceCalls.push(visible),
      log: () => {},
    },
  });
  return { renderer, scrollContainer, mount, document, resumeAffordanceCalls };
}

function lineNodes(renderer: LyricsRenderer): FakeNode[] {
  const container = renderer.container;
  assert.ok(container !== null, "Given built lyrics, When the view is asked, Then it holds a container");
  return asFakeNode(container).childNodes.filter(child => child.classList.contains(LINE_CLASS));
}

/** Lays the lines out the way a browser would, each line its height below the one before. */
function layOut(renderer: LyricsRenderer, heights: number[] = []): void {
  let top = 0;
  lineNodes(renderer).forEach((line, index) => {
    const height = heights[index] ?? LINE_HEIGHT_PX;
    line.offsetTop = top;
    line.offsetHeight = height;
    top += height + (LINE_PITCH_PX - LINE_HEIGHT_PX);
  });
}

function elementsOf(lines: readonly LineData[]): HTMLElement[] {
  return lines.map(line => line.lyricElement);
}

function startedAnimations(lines: readonly LineData[]): Animation[] {
  return lines.flatMap(line => [line, ...line.parts]).flatMap(part => part.animations);
}

function slides(element: HTMLElement): unknown[] {
  return asFakeNode(element).animations.filter(animation => animation.options?.composite === "add");
}

function playingView(): Fixture {
  const fixture = newFixture();
  fixture.renderer.setLyrics(song(...FIRST_SONG));
  layOut(fixture.renderer);
  fixture.renderer.relayout();
  fixture.renderer.tick(PLAYBACK_TIME_S, { isPlaying: true, eventCreationTime: Date.now() });
  return fixture;
}

// -- The same song again changes nothing on screen --------------------------------------------

{
  const { renderer, scrollContainer, mount } = playingView();
  const container = renderer.container;
  const lines = renderer.lines;
  const animations = startedAnimations(lines);
  const scrollTop = scrollContainer.scrollTop;
  assert.ok(
    animations.length > 0,
    "Given a playing view, When its lines are read, Then the line being sung is animating"
  );

  // A consumer that parses its source again hands over equal lyrics, never the same objects.
  renderer.setLyrics(song(...FIRST_SONG));

  assert.equal(
    renderer.container,
    container,
    "Given the same song again, When the view is asked, Then it kept its container"
  );
  assert.equal(
    mount.childNodes.length,
    1,
    "Given the same song again, When the mount is read, Then it still holds one container"
  );
  assert.deepEqual(
    renderer.lines,
    lines,
    "Given the same song again, When the view is asked, Then every line is the record it was"
  );
  assert.ok(
    animations.every(animation => !asFakeAnimation(animation).cancelled),
    "Given the same song again, When the line being sung is read, Then none of its animations was stopped"
  );
  assert.equal(
    scrollContainer.scrollTop,
    scrollTop,
    "Given the same song again, When the scroll is read, Then it has not moved"
  );
  assert.ok(
    lines.every(line => slides(line.lyricElement).length === 0),
    "Given the same song again, When the lines are read, Then none of them slid anywhere"
  );
}

// -- One line changed rebuilds that line alone --------------------------------------------

{
  const { renderer, scrollContainer } = playingView();
  const before = renderer.lines;
  const sungAnimations = startedAnimations([before[1]]);
  const scrollTop = scrollContainer.scrollTop;

  renderer.setLyrics(song("First line", "Second line", "Third line, rewritten", "Fourth line"));

  const after = renderer.lines;
  assert.deepEqual(
    [after[0], after[1], after[3]],
    [before[0], before[1], before[3]],
    "Given a song with one line changed, When the view is asked, Then every line that did not change is the record it was"
  );
  assert.notEqual(
    after[2],
    before[2],
    "Given a song with one line changed, When the view is asked, Then the changed line was built again"
  );
  assert.equal(
    asFakeNode(before[2].lyricElement).parentNode,
    null,
    "Given a song with one line changed, When the line it replaced is read, Then it left the view"
  );
  assert.deepEqual(
    lineNodes(renderer),
    elementsOf(after).map(element => asFakeNode(element)),
    "Given a song with one line changed, When the container is read, Then its lines are in the song's order"
  );
  assert.ok(
    sungAnimations.every(animation => !asFakeAnimation(animation).cancelled),
    "Given a change to a line not being sung, When the line being sung is read, Then its animations went on running"
  );
  assert.equal(
    scrollContainer.scrollTop,
    scrollTop,
    "Given a change that moved no line, When the scroll is read, Then it has not moved"
  );
}

// -- A line added above holds the line being sung still ----------------------------------------

{
  const { renderer, scrollContainer } = playingView();
  const before = renderer.lines;
  const scrollTop = scrollContainer.scrollTop;
  // Where the browser puts the kept lines once the new one is in above them: a pitch further down.
  for (const node of lineNodes(renderer)) node.offsetTop += LINE_PITCH_PX;

  renderer.setLyrics([{ startTimeMs: 0, durationMs: 0, words: "Spoken intro" }, ...song(...FIRST_SONG)]);

  const after = renderer.lines;
  assert.deepEqual(
    after.slice(1),
    before,
    "Given a line added at the top, When the view is asked, Then every other line was kept"
  );
  assert.deepEqual(
    after.map(line => line.lyricElement.dataset.lineNumber),
    ["0", "1", "2", "3", "4"],
    "Given a line added at the top, When the kept lines are read, Then each one is numbered where it now is"
  );
  assert.equal(
    scrollContainer.scrollTop,
    scrollTop + LINE_PITCH_PX,
    "Given a line added above the one being sung, When the scroll is read, Then it moved with that line, so it stays where the reader sees it"
  );
  assert.ok(
    before.every(line => slides(line.lyricElement).length === 0),
    "Given lines that moved exactly as far as the scroll did, When they are read, Then none of them slid"
  );
}

// -- A line that grew slides the ones below it rather than jumping them -------------------------

{
  const { renderer, scrollContainer } = playingView();
  const before = renderer.lines;
  const scrollTop = scrollContainer.scrollTop;
  // The last line grows; nothing above it moves, and the line under it is already the last.
  const nodes = lineNodes(renderer);
  nodes[3].offsetHeight = LINE_HEIGHT_PX * 2;

  renderer.setLyrics(song("First line", "Second line", "Third line", "Fourth line, much longer"));

  assert.equal(
    scrollContainer.scrollTop,
    scrollTop,
    "Given a line below the one being sung that changed, When the scroll is read, Then it held still"
  );
  assert.ok(
    before.slice(0, 3).every(line => slides(line.lyricElement).length === 0),
    "Given lines above a changed one, When they are read, Then none of them moved"
  );
}

// -- A reader scrolled away stays scrolled away --------------------------------------------

{
  const { renderer, resumeAffordanceCalls } = playingView();
  // Two scrolls are the build's own and the third is the reader's.
  for (let i = 0; i < 4; i++) renderer.noteUserScroll();
  const callsBefore = resumeAffordanceCalls.length;
  assert.equal(
    resumeAffordanceCalls.at(-1),
    true,
    "Given a reader who scrolled away, When the view is read, Then it offers the way back"
  );

  renderer.setLyrics(song("First line", "Second line, edited", "Third line", "Fourth line"));
  renderer.tick(PLAYBACK_TIME_S + ELAPSED_SINCE_START_MS / 1000, { isPlaying: true, eventCreationTime: Date.now() });

  assert.ok(
    !resumeAffordanceCalls.slice(callsBefore).includes(false),
    "Given a reader who scrolled away, When the song is swapped, Then the way back is still offered rather than the view following the song again"
  );
}

// -- Decorations on a kept line --------------------------------------------

{
  const { renderer, document } = playingView();
  const kept = renderer.lines[0];
  const doc = asDocument(document);
  const translations = (): FakeNode[] =>
    asFakeNode(kept.lyricElement).childNodes.filter(child => child.classList.contains(TRANSLATED_LYRICS_CLASS));
  injectTranslation(doc, kept.lyricElement, "Première ligne", "fr");
  const [translation] = translations();

  renderer.setLyrics(song(...FIRST_SONG));
  injectTranslation(doc, kept.lyricElement, "Première ligne", "fr");

  assert.deepEqual(
    translations(),
    [translation],
    "Given a kept line given the translation it already carries, When it is read, Then it carries that one translation, untouched"
  );

  injectTranslation(doc, kept.lyricElement, "Erste Zeile", "de");
  const replaced = translations();
  assert.equal(
    replaced.length,
    1,
    "Given a kept line given a different translation, When it is read, Then it carries one translation"
  );
  assert.equal(
    replaced[0].textContent,
    "Erste Zeile",
    "Given a kept line given a different translation, When it is read, Then it is the new one"
  );
}

{
  const { renderer, document } = playingView();
  const kept = renderer.lines[0];
  const doc = asDocument(document);
  const ownParts = kept.parts.length;
  const timed = (words: string[]) =>
    words.map((text, index) => ({
      startTimeMs: index * 1000,
      durationMs: 1000,
      words: index < words.length - 1 ? `${text} ` : text,
    }));
  injectRomanization(doc, kept.lyricElement, kept, "fasuto rain", timed(["fasuto", "rain"]));
  assert.equal(
    kept.parts.length,
    ownParts + 2,
    "Given a timed romanization, When the line is read, Then it animates the romanization's parts too"
  );

  injectRomanization(doc, kept.lyricElement, kept, "faasuto rain", timed(["faasuto", "rain"]));
  const romanizations = asFakeNode(kept.lyricElement).childNodes.filter(child =>
    child.classList.contains(ROMANIZED_LYRICS_CLASS)
  );
  assert.equal(
    romanizations.length,
    1,
    "Given a different timed romanization, When the line is read, Then it carries one romanization"
  );
  assert.equal(
    kept.parts.length,
    ownParts + 2,
    "Given a different timed romanization, When the line is read, Then the parts of the one it replaced went with it"
  );
}

// -- What still builds the whole view --------------------------------------------

{
  const { renderer } = playingView();
  const lines = renderer.lines;
  // What a consumer does to blank the view while it fetches, without letting go of the song.
  renderer.clearOnScreenLyrics();
  renderer.setLyrics(song(...FIRST_SONG));
  assert.equal(
    lineNodes(renderer).length,
    FIRST_SONG.length,
    "Given lines taken off the screen but not dropped, When the same song is given again, Then every line is on screen again"
  );
  assert.ok(
    renderer.lines.every(line => !lines.includes(line)),
    "Given lines taken off the screen but not dropped, When the same song is given again, Then none of the removed ones was kept"
  );
}

{
  const { renderer } = playingView();
  const container = renderer.container;
  renderer.setTheme("/* blyrics-disable-richsync = true; */");
  renderer.setLyrics(song(...FIRST_SONG));
  assert.notEqual(
    renderer.container,
    container,
    "Given a theme that changes how lines are built, When the same song is given again, Then the whole view is built again"
  );
  renderer.setTheme("");
}

{
  const { renderer, document } = playingView();
  const container = renderer.container;
  const elsewhere = document.createElement("div");
  renderer.setLyrics(song(...FIRST_SONG), { mount: asElement<HTMLElement>(elsewhere) });
  assert.notEqual(
    renderer.container,
    container,
    "Given a song for another mount, When the view is asked, Then it built a new container there"
  );
  assert.equal(
    asFakeNode(renderer.container!).parentNode,
    elsewhere,
    "Given a song for another mount, When its container is read, Then it is in that mount"
  );
}

{
  const { renderer } = playingView();
  const container = renderer.container;
  renderer.setLyrics(FIRST_SONG.map(words => ({ startTimeMs: 0, durationMs: 0, words })));
  assert.notEqual(
    renderer.container,
    container,
    "Given the same words with no timing, When the view is asked, Then it was built again, because every line now seeks differently"
  );
}

{
  const { renderer } = playingView();
  renderer.clear();
  renderer.setLyrics(song(...FIRST_SONG));
  assert.ok(renderer.container !== null, "Given a cleared view, When a song is given, Then it is built from nothing");
}

// -- The stage --------------------------------------------

{
  const { renderer } = newFixture("stage");
  renderer.setLyrics(song(...FIRST_SONG));
  layOut(renderer);
  renderer.relayout();
  renderer.tick(PLAYBACK_TIME_S, { isPlaying: true, eventCreationTime: Date.now() });
  const sung = renderer.lines[1];
  const role = sung.lyricElement.dataset.stageRole;
  assert.ok(role !== undefined, "Given a playing stage, When the sung line is read, Then the stage gave it a role");

  renderer.setLyrics(song("First line", "Second line, retimed", "Third line", "Fourth line"));
  const replacement = renderer.lines[1];
  assert.notEqual(
    replacement,
    sung,
    "Given a stage whose sung line changed, When it is asked, Then that line was built again"
  );
  assert.equal(
    replacement.lyricElement.dataset.stageRole,
    role,
    "Given a stage whose sung line changed, When the new line is read, Then it took over the role of the line it replaced"
  );
}

console.log("Lyrics swap self-check passed");

// Builds the view: one container under the mount, one element per lyric line, and the render
// records the engine animates them through. `inject.ts` builds what goes inside a line; this builds
// the line and everything around it.
//
// A first song builds the whole view. A song given to a view that already holds one is swapped into
// it line by line: a line that would build the same as one already on screen keeps that element, its
// record and the animations running against it, and only the lines that differ are built again. The
// engine is told which records went and which new ones stand where they stood, so nothing it holds
// keeps pointing into the song before. Anything that changes every line at once (the mount, a theme
// setting lines are built by, lyrics that lose or gain their timing) builds the whole view again.
//
// This is also the one place outside the engine that writes engine view state, because building the
// lines is where those values are first knowable: the container, the records, the sync type, the
// size they were measured at, and the scrolls to swallow before the view has settled.

import {
  CREDITS_CLASS,
  CREDITS_NAMES_CLASS,
  CREDITS_TEXT_CLASS,
  LINE_CLASS,
  LYRICS_CLASS,
  RTL_CLASS,
} from "./constants";
import {
  type AnimationEngineInstance,
  lineScrollOffset,
  playerTimeForLyricTime,
  replaceRenderedLines,
  setupLineCullObserver,
} from "./engine";
import {
  addSeekHandler,
  applyDirection,
  buildLineSyncedParts,
  createLyricsLine,
  deriveSyncType,
  disableRichsync,
  findNearestAgent,
  hideCredits,
  isNearestLyricRtl,
  type LineData,
  moveDecorations,
  newLineData,
} from "./inject";
import { refreshInstrumentalImages } from "./imageHighlights";
import { createInstrumentalElement } from "./instrumental";
import type { Lyric } from "./types";
import { applyLyricLanguage, resolveLyricLanguages } from "./language";
import { lyricBuildSettingsKey } from "./themeSettings";
import { isGecko } from "./util";

const INITIAL_SKIP_SCROLLS = 2;
const SKIP_SCROLL_DECAY_MS = 2000;

export interface SetLyricsOptions {
  /** BCP 47 language of the original lyrics. Kana/Hangul provide a fallback when omitted. */
  language?: string | null;
  /**
   * Whether the loader is still covering the view. Recorded on the container for CSS to key on.
   */
  loaderVisible: boolean;
  /**
   * These lyrics are a "not found" placeholder rather than a real result.
   */
  noLyrics: boolean;
  /** Who wrote the song, shown after the last line. */
  songwriters?: readonly string[];
  /**
   * Which song these lyrics are for. Lyrics given with the key the view on screen was given are
   * swapped into it, so lines the two share stay as they were; without a key, or with another one,
   * the view is built anew.
   */
  songKey?: string;
}

function buildInstrumentalLine(doc: Document, lyricElement: HTMLDivElement, lyrics: Lyric[], lineIndex: number): void {
  createInstrumentalElement(doc, lyricElement, lyrics[lineIndex].durationMs);
  lyricElement.dataset.instrumental = "true";

  const agent = findNearestAgent(lyrics, lineIndex);
  if (agent) {
    lyricElement.dataset.agent = agent;
  }

  if (isNearestLyricRtl(lyrics, lineIndex)) {
    lyricElement.classList.add(RTL_CLASS);
    lyricElement.dataset.direction = "rtl";
  }
}

function buildSungLine(doc: Document, lyricElement: HTMLDivElement, lyricItem: Lyric, line: LineData): void {
  // Rebuilt parts stay local so the provider's lyrics survive injection intact and a second
  // build over the same array produces the same result.
  const parts =
    lyricItem.parts && lyricItem.parts.length > 0 && !disableRichsync.getBooleanValue()
      ? lyricItem.parts
      : buildLineSyncedParts(lyricItem);

  applyDirection(lyricElement, lyricItem.words);
  createLyricsLine(doc, parts, line, lyricElement);

  lyricElement.style.setProperty("--blyrics-duration", lyricItem.durationMs + "ms");
  if (lyricItem.agent) {
    lyricElement.dataset.agent = lyricItem.agent;
  }
}

function formatSongwriters(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} & ${names.at(-1)}` : (names[0] ?? "");
}

function buildCredits(doc: Document, songwriters: readonly string[]): HTMLParagraphElement {
  // Not a div: themes style the lines as `.blyrics-container > div`, and none of that is meant for the credits.
  const credits = doc.createElement("p");
  credits.className = CREDITS_CLASS;
  // The smaller size lives on an inner block so the credits keep the lines' em, and with it their inset.
  const text = doc.createElement("span");
  text.className = CREDITS_TEXT_CLASS;
  const names = doc.createElement("span");
  names.className = CREDITS_NAMES_CLASS;
  names.dir = "auto";
  names.textContent = formatSongwriters(songwriters);
  text.appendChild(names);
  credits.appendChild(text);
  return credits;
}

// -- Building lines --------------------------

/** What every line of one build is built against, so a swap can tell whether a line still builds the same. */
interface BuildContext {
  allZero: boolean;
  languages: ReturnType<typeof resolveLyricLanguages>;
  seek: (timeS: number) => void;
}

/** Everything a line's element is built from, so two lines that answer the same build the same. */
const lineSignatures = new WeakMap<LineData, string>();

/**
 * A line's words and what a consumer decorates it from. A line rebuilt for its timing alone answers
 * the same, so the translation and romanization hung on the line it replaced still belong to it.
 */
const decorationKeys = new WeakMap<LineData, string>();

function decorationKey(item: Lyric): string {
  return JSON.stringify([
    item.words,
    item.translation ?? null,
    item.translations ?? null,
    item.romanization ?? null,
    item.timedRomanization ?? null,
  ]);
}

/** What the lines on screen were built against: the mount, the settings and whether they carry time. */
const builtViews = new WeakMap<AnimationEngineInstance, { mount: HTMLElement; key: string; songKey?: string }>();

/** A line's own timing as built, so a line whose times a consumer moved since is not kept as it is. */
const builtTimings = new WeakMap<LineData, number[]>();

function lineTimings(line: LineData, parts: readonly LineData["parts"][number][] = line.parts): number[] {
  return [line.time, line.duration, ...parts.flatMap(part => [part.time, part.duration])];
}

function timingsUnchanged(line: LineData): boolean {
  const built = builtTimings.get(line);
  if (built === undefined) return false;
  const now = lineTimings(line, line.parts.slice(0, (built.length - 2) / 2));
  return now.length === built.length && now.every((value, index) => value === built[index]);
}

function buildContext(engine: AnimationEngineInstance, lyrics: Lyric[], options: SetLyricsOptions): BuildContext {
  return {
    allZero: lyrics.every(item => item.startTimeMs === 0),
    languages: resolveLyricLanguages(lyrics, options.language),
    seek: timeS => engine.host.seek(playerTimeForLyricTime(engine, timeS)),
  };
}

function viewKey(context: BuildContext): string {
  return `${context.allZero}|${lyricBuildSettingsKey()}`;
}

// The language is left out: it is an attribute rather than anything built, and a swap writes it onto
// every kept line instead.
function lineSignature(lyrics: Lyric[], lineIndex: number): string {
  const item = lyrics[lineIndex];
  const parts = item.parts?.map(part => [
    part.startTimeMs,
    part.durationMs,
    part.words,
    part.isBackground === true,
    part.explicit === true,
  ]);
  // An instrumental line takes its side and direction from the lines around it.
  const neighbours = item.isInstrumental
    ? [findNearestAgent(lyrics, lineIndex), isNearestLyricRtl(lyrics, lineIndex)]
    : null;
  return JSON.stringify([
    item.startTimeMs,
    item.durationMs,
    item.words,
    item.isInstrumental === true,
    item.agent ?? null,
    parts ?? null,
    neighbours,
    decorationKey(item),
  ]);
}

function buildLine(doc: Document, lyrics: Lyric[], lineIndex: number, context: BuildContext): LineData {
  const lyricItem = lyrics[lineIndex];
  const lyricElement = doc.createElement("div");
  const line = newLineData(lyricElement, lyricItem.startTimeMs, lyricItem.durationMs);

  lyricElement.dataset.time = String(line.time);
  lyricElement.dataset.duration = String(line.duration);
  lyricElement.dataset.lineNumber = String(lineIndex);
  lyricElement.classList.add(LINE_CLASS);
  lyricElement.dir = "auto";
  applyLyricLanguage(lyricElement, context.languages[lineIndex]);
  addSeekHandler(context.seek, lyricElement, context.allZero);

  if (lyricItem.isInstrumental) {
    buildInstrumentalLine(doc, lyricElement, lyrics, lineIndex);
  } else {
    buildSungLine(doc, lyricElement, lyricItem, line);
    if (!lyricItem.words?.trim()) lyricElement.dataset.blank = "true";
  }

  lineSignatures.set(line, lineSignature(lyrics, lineIndex));
  decorationKeys.set(line, decorationKey(lyricItem));
  builtTimings.set(line, lineTimings(line));
  return line;
}

/**
 * Writes what the container records about the song as a whole, over whatever it recorded about the
 * last one, and puts the credits after the last line.
 */
function writeContainerState(
  engine: AnimationEngineInstance,
  container: HTMLElement,
  lyrics: Lyric[],
  options: SetLyricsOptions,
  creditsBefore: Node | null = null
): void {
  const doc = engine.document;
  const syncType = deriveSyncType(lyrics);
  container.dataset.sync = syncType;
  if (engine.layout === "stage") {
    container.dataset.layout = "stage";
    // Sides only when both are sung, so a song with one singer stays centred whichever voice it is.
    const sung = lyrics.filter(item => !item.isInstrumental && item.words?.trim() && item.agent !== "v1000");
    const onRight = (item: Lyric): boolean => item.agent === "v2" || item.agent === "v3";
    if (sung.some(onRight) && sung.some(item => !onRight(item))) {
      container.dataset.stageDuet = "";
    } else {
      delete container.dataset.stageDuet;
    }
  }
  container.dataset.loaderVisible = String(options.loaderVisible);
  if (options.noLyrics) {
    container.dataset.noLyrics = "true";
  } else {
    delete container.dataset.noLyrics;
  }

  // Built again on every song, even the same names: consumers hang their own things off the credits
  // once per build, and a kept one would collect them.
  container.querySelector(`:scope > .${CREDITS_CLASS}`)?.remove();
  const songwriters = options.songwriters ?? [];
  if (songwriters.length > 0 && !options.noLyrics && !hideCredits.getBooleanValue()) {
    container.insertBefore(buildCredits(doc, songwriters), creditsBefore);
  }

  engine.syncType = syncType;
}

/**
 * Replaces whatever the mount holds with a container built from these lyrics, and hands the render
 * records, the container and its measured size to the engine that animates them.
 *
 * @param engine - Instance that owns the document to build in and the host to seek through
 * @param mount - Element whose children the built container replaces
 * @param lyrics - Lines to render, left untouched
 * @param options - What the container records for CSS to key on
 */
export function setLyrics(
  engine: AnimationEngineInstance,
  mount: HTMLElement,
  lyrics: Lyric[],
  options: SetLyricsOptions
): void {
  const doc = engine.document;
  const container = doc.createElement("div");
  container.className = LYRICS_CLASS;
  if (isGecko()) container.dataset.browserEngine = "gecko";
  mount.replaceChildren(container);

  const context = buildContext(engine, lyrics, options);
  const lines: LineData[] = [];
  for (const lineIndex of lyrics.keys()) {
    const line = buildLine(doc, lyrics, lineIndex, context);
    lines.push(line);
    container.appendChild(line.lyricElement);
  }

  engine.skipScrolls = INITIAL_SKIP_SCROLLS;
  engine.skipScrollsDecayTimes = Array.from({ length: INITIAL_SKIP_SCROLLS }, () => Date.now() + SKIP_SCROLL_DECAY_MS);
  engine.scrollResumeTime = 0;

  writeContainerState(engine, container, lyrics, options);

  engine.lines = lines;
  engine.lyricsContainer = container;
  builtViews.set(engine, { mount, key: viewKey(context), songKey: options.songKey });
  refreshInstrumentalImages(container, engine.window);
  // Measured last: the container is in the document, filled, and carrying the attributes CSS
  // sizes it by.
  engine.lyricWidth = container.clientWidth;
  engine.lyricHeight = container.clientHeight;
  setupLineCullObserver(engine);
}

/**
 * Where each line of a swap was before it, in the container's coordinates, and how tall it was: a
 * kept line's own place, and for a line built in place of one, the place of the line it replaced.
 */
export type SwapPositions = Map<LineData, { position: number; height: number; offset: number }>;

/**
 * Pairs each new line with an old one that builds the same, keeping their order, so a kept element is
 * never moved: the longest run of matches, found after the ends both songs share are set aside.
 */
function matchLines(previous: readonly string[], next: readonly string[]): (number | null)[] {
  const matches: (number | null)[] = next.map(() => null);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) {
    matches[start] = start;
    start++;
  }
  let previousEnd = previous.length;
  let nextEnd = next.length;
  while (previousEnd > start && nextEnd > start && previous[previousEnd - 1] === next[nextEnd - 1]) {
    previousEnd--;
    nextEnd--;
    matches[nextEnd] = previousEnd;
  }

  const rows = previousEnd - start;
  const columns = nextEnd - start;
  // A whole new song is no match for the one before and costs nothing to find out. Past this size
  // the middle is rebuilt rather than searched, which is what every song was before swaps existed.
  if (rows === 0 || columns === 0 || rows * columns > MATCH_SEARCH_LIMIT) return matches;

  const lengths = new Uint16Array((rows + 1) * (columns + 1));
  const at = (row: number, column: number): number => row * (columns + 1) + column;
  for (let row = rows - 1; row >= 0; row--) {
    for (let column = columns - 1; column >= 0; column--) {
      lengths[at(row, column)] =
        previous[start + row] === next[start + column]
          ? lengths[at(row + 1, column + 1)] + 1
          : Math.max(lengths[at(row + 1, column)], lengths[at(row, column + 1)]);
    }
  }
  let row = 0;
  let column = 0;
  while (row < rows && column < columns) {
    if (previous[start + row] === next[start + column]) {
      matches[start + column] = start + row;
      row++;
      column++;
    } else if (lengths[at(row + 1, column)] >= lengths[at(row, column + 1)]) {
      row++;
    } else {
      column++;
    }
  }
  return matches;
}

const MATCH_SEARCH_LIMIT = 250_000;

/**
 * Takes the first old line sung over the same time as a new one, so a line rebuilt for a retiming or
 * a richer source takes over its predecessor's place, and an unrelated line never inherits a sung state.
 */
function takeOverlapping(candidates: LineData[], line: LineData): LineData | undefined {
  const end = line.time + line.duration;
  const index = candidates.findIndex(old => {
    const oldEnd = old.time + old.duration;
    return old.time === line.time || (old.time < end && line.time < oldEnd);
  });
  return index === -1 ? undefined : candidates.splice(index, 1)[0];
}

/**
 * Swaps these lyrics into the view already on screen, rebuilding only the lines that differ, and
 * answers where each line was before so the caller can carry the view across the change. Answers
 * null without touching anything when the view cannot be swapped, and the caller builds it whole.
 *
 * Nothing about where the reader is goes back to the start of a song: the scroll, a pause the reader
 * scrolled into, and the scrolls the engine is waiting to swallow are all the song's before.
 */
export function swapLyrics(
  engine: AnimationEngineInstance,
  mount: HTMLElement,
  lyrics: Lyric[],
  options: SetLyricsOptions
): SwapPositions | null {
  const container = engine.lyricsContainer;
  const built = builtViews.get(engine);
  if (container === null || built === undefined || built.mount !== mount || container.parentElement !== mount) {
    return null;
  }
  // Another song, or one nobody named, starts from nothing rather than inheriting this one's place.
  if (options.songKey === undefined || options.songKey !== built.songKey) return null;
  // Lines a consumer took off the screen without dropping the song are not there to keep.
  const previousLines = engine.lines;
  // An empty song is a fresh start rather than a song to carry anything into.
  if (lyrics.length === 0 || previousLines.length === 0) return null;
  if (previousLines.some(line => line.lyricElement.parentNode !== container)) return null;
  const context = buildContext(engine, lyrics, options);
  if (built.key !== viewKey(context)) return null;

  const doc = engine.document;
  // A line whose times a consumer moved after it was built is built again, so the move is not applied twice.
  const previousSignatures = previousLines.map(line =>
    timingsUnchanged(line) ? (lineSignatures.get(line) ?? "") : `\u0000moved:${lineSignatures.get(line)}`
  );
  const nextSignatures = lyrics.map((_, lineIndex) => lineSignature(lyrics, lineIndex));
  // Whatever a consumer put after the lines and the credits, such as a footer, stays after them.
  const children = Array.from(container.childNodes);
  const oldCredits = container.querySelector(`:scope > .${CREDITS_CLASS}`);
  const lastOwned = oldCredits ?? previousLines[previousLines.length - 1].lyricElement;
  const trailing = children[children.indexOf(lastOwned) + 1] ?? null;
  const matches = matchLines(previousSignatures, nextSignatures);

  const kept = new Set<LineData>();
  const lines: LineData[] = [];
  // A new line stands in for an old one when both sit in the same gap between kept lines, in order,
  // so the engine can hand it what it held for the line it replaced.
  const replaced = new Map<LineData, LineData>();
  const positions: SwapPositions = new Map();
  let previousCursor = 0;
  let unmatchedOld: LineData[] = [];

  const collectUnmatchedUntil = (end: number): void => {
    unmatchedOld = previousLines.slice(previousCursor, end);
    previousCursor = end;
  };

  for (const [lineIndex, match] of matches.entries()) {
    if (match !== null) {
      const line = previousLines[match];
      previousCursor = match + 1;
      unmatchedOld = [];
      kept.add(line);
      line.lyricElement.dataset.lineNumber = String(lineIndex);
      applyLyricLanguage(line.lyricElement, context.languages[lineIndex]);
      lines.push(line);
      positions.set(line, { position: line.position, height: line.height, offset: 0 });
      continue;
    }
    if (unmatchedOld.length === 0) {
      const nextMatch = matches.slice(lineIndex).find(value => value !== null);
      collectUnmatchedUntil(nextMatch ?? previousLines.length);
    }
    const line = buildLine(doc, lyrics, lineIndex, context);
    const standsFor = takeOverlapping(unmatchedOld, line);
    if (standsFor !== undefined) {
      replaced.set(line, standsFor);
      positions.set(line, {
        position: standsFor.position,
        height: standsFor.height,
        // A kept line finishes its own line scroll; this one starts where the line it replaced was.
        offset: lineScrollOffset(engine, standsFor.lyricElement),
      });
      if (decorationKeys.get(standsFor) === decorationKeys.get(line)) moveDecorations(standsFor, line);
    }
    lines.push(line);
  }

  const dropped = previousLines.filter(line => !kept.has(line));
  // In order, each new line before whichever kept line follows it, so a kept element never leaves the
  // document and never loses the animations running against it.
  let following: Node | null = oldCredits ?? trailing;
  for (let index = lines.length - 1; index >= 0; index--) {
    const element = lines[index].lyricElement;
    if (!kept.has(lines[index])) container.insertBefore(element, following);
    following = element;
  }
  replaceRenderedLines(engine, lines, dropped, replaced);
  for (const line of dropped) line.lyricElement.remove();

  writeContainerState(engine, container, lyrics, options, trailing);
  refreshInstrumentalImages(container, engine.window);
  return positions;
}

// Runs @braccato/core straight off the artifact `pnpm package` emitted, wires every control on
// the page to a property on the tag, and reports two things that can only be checked in a real
// browser:
//
//   1. The element upgrades. The parser builds <braccato-lyrics> with its attributes already on it,
//      before the module that defines it exists, so the attribute reactions are delivered during the
//      upgrade and connectedCallback runs on an element that already knows its source and its theme.
//   2. The cascade reaches in. The package's stylesheets and this page's own both select the
//      module's class names at document level, which only works because the element builds into
//      light DOM.
//
// The package is imported dynamically rather than at the top of this module so that the state before
// it loaded can be read at all: a static import is hoisted above every statement in the file.
//
// The stylesheets are the exception, and they are static because CSS has nothing to observe. Order
// is the cascade: the package's variables first because the other two read from them, and this
// page's own sheet last because it overrides all three.

import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import "./demo.css";

import { TextMorph } from "torph";

import {
  ATTRIBUTES,
  CLASS_NAMES,
  CUSTOM_PROPERTIES,
  EVENTS,
  INSTALLERS,
  PACKAGE,
  PROPERTIES,
  SNIPPETS,
  STYLESHEETS,
  THEME_SETTINGS,
} from "./api.js";
import { loadParsers, parseLyrics, PARSERS_SPECIFIER } from "./parsers.js";
import { buildScore, SONGS } from "./song.js";
import { THEMES } from "./themes.js";

const TAG_NAME = "braccato-lyrics";
const LOG_LIMIT = 24;
const COPIED_ICON_MS = 1600;
const THEME_APPLY_DELAY_MS = 250;
const SWAP_OUT_MS = 200;
const ARRAY_PREVIEW_LIMIT = 12000;
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus|weba|webm)$/i;
// A typed URL becomes the player's `src`, and parsing one only says it is well formed. `javascript:`
// and `data:` both parse, so the scheme is checked separately against what can carry audio here.
const AUDIO_URL_SCHEMES = new Set(["http:", "https:"]);
const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const NARROW = "(max-width: 900px)";

const view = document.querySelector(TAG_NAME);
const player = document.getElementById("player");
const frame = document.getElementById("stage-frame");
const stage = document.getElementById("stage");
const stageStatus = document.getElementById("stage-status");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

const installTabs = document.getElementById("install-tabs");
const installText = document.getElementById("install-text");
const installCopy = document.getElementById("install-copy");

const heroPlay = document.getElementById("hero-play");
const heroPlayLabel = document.getElementById("hero-play-label");
const playButton = document.getElementById("play");
const resumeButton = document.getElementById("resume");
const seekInput = document.getElementById("seek");
const elapsedOutput = document.getElementById("elapsed");
const durationOutput = document.getElementById("duration");
const songSelect = document.getElementById("song-select");

const rail = document.getElementById("rail");
const captionLabel = document.getElementById("caption-label");
const captionSong = document.getElementById("now-playing");
const captionTheme = document.getElementById("caption-theme");

const songList = document.getElementById("song-list");
const songFileButton = document.getElementById("song-file");
const songUrlInput = document.getElementById("song-url");
const songUrlButton = document.getElementById("song-url-load");
const songStatus = document.getElementById("song-status");

const timingFieldset = document.getElementById("timing");
const timingHint = document.getElementById("timing-hint");
const lyricsFileInput = document.getElementById("lyrics-file");
const lyricsTextArea = document.getElementById("lyrics-text");
const lyricsImportButton = document.getElementById("lyrics-import");
const lyricsStatus = document.getElementById("lyrics-status");
const lyricsArray = document.getElementById("lyrics-array");

const themeList = document.getElementById("theme-list");
const themeSummary = document.getElementById("theme-summary");
const themeEditor = document.getElementById("theme-text");
const themePaint = document.getElementById("theme-paint");
const themeStatus = document.getElementById("theme-status");

const offsetInput = document.getElementById("offset");
const offsetValue = document.getElementById("offset-value");
const passiveScrollInput = document.getElementById("passive-scroll");
const viewScrollInput = document.getElementById("scrollable-view");
const pageRulesInput = document.getElementById("page-rules");
const injectRomanizationsButton = document.getElementById("inject-romanizations");
const injectTranslationsButton = document.getElementById("inject-translations");
const injectBothButton = document.getElementById("inject-both");
const animateDecorationsInput = document.getElementById("animate-decorations");

const referenceTabs = document.getElementById("reference-tabs");
const eventLog = document.getElementById("event-log");
const dropzone = document.getElementById("dropzone");

const DEMO_DECORATIONS = [
  { roman: "hikari no naka de", trans: "inside the light" },
  { roman: "kaze ga fuku hi ni", trans: "on a day the wind blows" },
  { roman: "kimi no koe ga suru", trans: "I can hear your voice" },
  { roman: "yoru wo koete", trans: "past the night" },
  { roman: "tooku made", trans: "as far as it goes" },
  { roman: "mou ichido", trans: "one more time" },
];

let injectTranslation = () => false;
let injectRomanization = () => false;

// -- Before the module exists --------------------------------------------

const beforeUpgrade = {
  registered: customElements.get(TAG_NAME) !== undefined,
  constructorName: view.constructor.name,
  hasAccessors: "source" in view,
  sourceAttribute: view.getAttribute("source"),
  themeAttribute: view.getAttribute("theme") ?? "",
};

// -- Small DOM helpers --------------------------------------------

function renderReadout(list, rows) {
  list.replaceChildren(
    ...rows.map(row => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = row.label;
      const value = document.createElement("dd");
      value.textContent = row.value;
      if (row.state) value.dataset.state = row.state;
      group.append(term, value);
      return group;
    })
  );
}

function renderTerms(list, rows) {
  list.replaceChildren(
    ...rows.map(row => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      const name = document.createElement("code");
      name.textContent = row.term;
      term.append(name);

      if (row.meta) {
        const meta = document.createElement("span");
        meta.className = "terms__meta";
        meta.textContent = row.meta;
        term.append(meta);
      }

      const definition = document.createElement("dd");
      definition.textContent = row.definition;
      group.append(term, definition);
      return group;
    })
  );
}

function report(element, message, tone) {
  element.textContent = message;
  if (tone === undefined) element.removeAttribute("data-tone");
  else element.dataset.tone = tone;
}

function wireCopy(button, label, read) {
  button.setAttribute("aria-label", label);
  let timer = 0;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(read());
      button.dataset.copied = "";
      button.setAttribute("aria-label", "Copied");
    } catch {
      button.setAttribute("aria-label", "Clipboard blocked");
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.removeAttribute("data-copied");
      button.setAttribute("aria-label", label);
    }, COPIED_ICON_MS);
  });
}

function copyButton(label, read) {
  const button = document.createElement("button");
  button.className = "icon-button";
  button.type = "button";
  button.innerHTML =
    '<svg class="icon icon--idle" aria-hidden="true"><use href="#i-copy" /></svg>' +
    '<svg class="icon icon--done" aria-hidden="true"><use href="#i-check" /></svg>';
  wireCopy(button, label, read);
  return button;
}

/** Text that changes in place, morphed a letter at a time so the box around it resizes smoothly. */
const morphs = new Map();

function morphText(element, text) {
  let entry = morphs.get(element);
  if (entry === undefined) {
    entry = { morph: new TextMorph({ element, duration: 420, ease: EASE }), text: null };
    morphs.set(element, entry);
  }
  if (entry.text === text) return;
  entry.text = text;
  entry.morph.update(text);
}

/** Moves a sliding indicator under whichever item is current, or fades it out when none is. */
function slide(container, active) {
  container.style.setProperty("--o", active ? "1" : "0");
  if (!active) return;
  container.style.setProperty("--x", `${active.offsetLeft}px`);
  container.style.setProperty("--w", `${active.offsetWidth}px`);
}

function slideSegment(fieldset) {
  slide(fieldset, fieldset.querySelector("input:checked")?.parentElement ?? null);
}

// -- Code samples --------------------------------------------

// Two passes over the same shape, one for script and one for CSS. Everything a pass does not name is
// collected and appended as a single text node, so a page of code costs a handful of elements rather
// than one per character.

function token(className, text) {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

// One pass, six named things and everything else. The identifiers picked out are the package's own,
// which is the point: what a reader's eye should land on in a sample is the API, not the syntax.
const TOKEN_PATTERN = new RegExp(
  [
    String.raw`(\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->)`,
    String.raw`("[^"]*"|'[^']*')`,
    // An arrow, a comparison and a dash are not a closing tag, whatever they end with.
    String.raw`(<\/?[A-Za-z][\w-]*|\/>|(?<![=!<>-])>)`,
    String.raw`\b(import|from|const|let|await|async|function|return|export|new|document|querySelector|fetch|then)\b`,
    String.raw`\b(braccato-lyrics|startTimeMs|durationMs|lyricsOptions|tickOptions|mediaElement|currentTime|detectParser|renderer|playing|lyrics|source|status|theme|parts|words|host|parse)\b`,
    String.raw`\b(\d+(?:\.\d+)?)\b`,
    // A template literal in these samples is a stylesheet, because a theme is written as one. Its
    // contents go through the CSS pass instead of this one.
    String.raw`\`([\s\S]*?)\``,
    String.raw`([\s\S])`,
  ].join("|"),
  "g"
);

const TOKEN_CLASSES = ["c-c", "c-s", "c-t", "c-k", "c-b", "c-n"];
const STYLES_GROUP = TOKEN_CLASSES.length + 1;

function highlight(code) {
  const fragment = document.createDocumentFragment();
  let plain = "";

  for (const match of code.matchAll(TOKEN_PATTERN)) {
    const index = TOKEN_CLASSES.findIndex((_, group) => match[group + 1] !== undefined);
    if (index === -1 && match[STYLES_GROUP] === undefined) {
      plain += match[0];
      continue;
    }

    if (plain !== "") {
      fragment.append(plain);
      plain = "";
    }

    if (index === -1) fragment.append("`", highlightStyles(match[STYLES_GROUP]), "`");
    else fragment.append(token(TOKEN_CLASSES[index], match[0]));
  }

  if (plain !== "") fragment.append(plain);
  return fragment;
}

// -- The CSS pass --------------------------------------------

// A string and a comment are consumed whole whether or not they are coloured, because a brace or a
// semicolon inside either one would otherwise be read as structure.
const STYLE_TOKEN_PATTERN = new RegExp(
  [
    String.raw`(\/\*[\s\S]*?\*\/)`,
    String.raw`("[^"\n]*"|'[^'\n]*')`,
    String.raw`(@[\w-]+|!\s*important)`,
    String.raw`([\w-]*blyrics[\w-]*)`,
    String.raw`(-?(?:\d*\.)?\d+[a-z%]*)`,
    String.raw`([A-Za-z_-][\w-]*)`,
    String.raw`([\s\S])`,
  ].join("|"),
  "g"
);

// The only comments the module reads, in the same shape `parseThemeConfig` looks for. Written out
// here because colouring wants the positions and that function returns the values, and a highlighter
// that disagreed with the parser about what a setting is would be worse than no colour at all.
const STYLE_SETTING_PATTERN = /blyrics-[\w-]+\s*=\s*[^;]+;/g;

/** Prose grey, and the `blyrics-*` lines the module reads picked out of it. */
function appendComment(fragment, comment) {
  let at = 0;

  for (const match of comment.matchAll(STYLE_SETTING_PATTERN)) {
    if (match.index > at) fragment.append(token("c-c", comment.slice(at, match.index)));
    fragment.append(token("c-a", match[0]));
    at = match.index + match[0].length;
  }

  if (at < comment.length) fragment.append(token("c-c", comment.slice(at)));
}

/**
 * The stylesheet as coloured nodes. Whether a name is a property or part of a selector is the one
 * thing CSS cannot be tokenised without tracking, so the braces are counted, and each one remembers
 * whether an at-rule opened it: the rules inside `@media` are still rules.
 */
function highlightStyles(css) {
  const fragment = document.createDocumentFragment();
  const openedByAtRule = [];
  let atRulePending = false;
  let inValue = false;
  let plain = "";

  const flush = () => {
    if (plain === "") return;
    fragment.append(plain);
    plain = "";
  };

  const inDeclarations = () => openedByAtRule.length > 0 && !openedByAtRule[openedByAtRule.length - 1];

  for (const [, comment, string, keyword, name, number, word, other] of css.matchAll(STYLE_TOKEN_PATTERN)) {
    if (comment !== undefined) {
      flush();
      appendComment(fragment, comment);
    } else if (string !== undefined) {
      plain += string;
    } else if (keyword !== undefined) {
      flush();
      if (keyword.startsWith("@")) atRulePending = true;
      fragment.append(token("c-k", keyword));
    } else if (name !== undefined) {
      flush();
      fragment.append(token("c-b", name));
    } else if (number !== undefined) {
      flush();
      fragment.append(token("c-n", number));
    } else if (word !== undefined) {
      if (!inDeclarations() || inValue) {
        plain += word;
      } else {
        flush();
        fragment.append(token("c-k", word));
      }
    } else {
      if (other === "{") {
        openedByAtRule.push(atRulePending);
        atRulePending = false;
        inValue = false;
      } else if (other === "}") {
        openedByAtRule.pop();
        inValue = false;
      } else if (other === ":" && inDeclarations()) {
        inValue = true;
      } else if (other === ";") {
        atRulePending = false;
        inValue = false;
      }
      plain += other;
    }
  }

  flush();
  return fragment;
}

function renderSnippets() {
  for (const block of document.querySelectorAll(".code[data-snippet]")) {
    const name = block.dataset.snippet;
    const source = SNIPPETS[name];

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.append(highlight(source));
    pre.append(code);

    block.replaceChildren(
      pre,
      copyButton(`Copy the ${name} example`, () => source)
    );
  }
}

// -- Install --------------------------------------------

function renderInstall() {
  installTabs.append(
    ...INSTALLERS.map(installer => {
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "radio";
      input.name = "installer";
      input.value = installer.id;
      input.checked = installer.id === state.installer;
      const text = document.createElement("span");
      text.textContent = installer.label;
      label.append(input, text);
      return label;
    })
  );

  installTabs.addEventListener("change", event => {
    state.installer = event.target.value;
    paintInstall();
  });

  wireCopy(installCopy, "Copy the install command", installCommand);
}

function installCommand() {
  const installer = INSTALLERS.find(candidate => candidate.id === state.installer);
  return `${installer.command} ${PACKAGE.name}`;
}

function paintInstall() {
  morphText(installText, installCommand());
  slideSegment(installTabs);
}

// -- The song, in four shapes --------------------------------------------

const scores = new Map();
const shapes = new Map();

function scoreFor(songId) {
  if (!scores.has(songId)) scores.set(songId, buildScore(songId).lyrics);
  return scores.get(songId);
}

// The same song told four ways, because `deriveSyncType` reads the timing rather than being told
// about it: parts with a duration make it richsync, a non-zero start makes it synced, and lines that
// all start at zero are how a consumer says these came with no timing at all.
const TIMINGS = {
  syllables: {
    label: "Syllable timing",
    hint: "Each line has parts, so every syllable lights up in turn.",
    shape: score => score,
  },
  lines: {
    label: "Line synced",
    hint: "The same lines without parts. The line lights up as a whole.",
    shape: score =>
      score.map(line => ({
        startTimeMs: line.startTimeMs,
        durationMs: line.durationMs,
        words: line.words,
        isInstrumental: line.isInstrumental,
      })),
  },
  plain: {
    label: "Unsynced",
    hint: "Every start time is zero, which means unsynced. Only passive scroll moves them.",
    shape: score =>
      score.filter(line => !line.isInstrumental).map(line => ({ startTimeMs: 0, durationMs: 0, words: line.words })),
  },
  empty: {
    label: "No lyrics",
    hint: "One message line with noLyrics set, so passive scroll leaves it alone.",
    shape: () => [{ startTimeMs: 0, durationMs: 0, words: "No lyrics for this one." }],
  },
};

/**
 * Cached per song and shape, because the element compares what it is handed against what it already
 * has, and a fresh array on every commit would rebuild the view every time a slider moved.
 */
function builtInLyrics() {
  const key = `${state.songId}|${state.timing}`;
  if (!shapes.has(key)) shapes.set(key, TIMINGS[state.timing].shape(scoreFor(state.songId)));
  return shapes.get(key);
}

// -- State --------------------------------------------

const DEFAULT_THEME = THEMES[0];

const DEFAULTS = {
  songId: SONGS[0].id,
  timing: "syllables",
  themeId: DEFAULT_THEME.id,
  offsetMs: 0,
  passiveScroll: false,
  viewScroll: true,
  pageRules: true,
};

const state = {
  ...DEFAULTS,
  installer: INSTALLERS[0].id,
  themeText: DEFAULT_THEME.css,
  importedLyrics: null,
  importedName: "",
  audio: null,
  // The chapters pick the song and the timing until the reader picks either themselves. After that
  // scrolling changes nothing that is playing.
  touring: true,
};

const applied = { lyrics: null, theme: null, audioUrl: null };

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readStateFromUrl() {
  const params = new URLSearchParams(location.search);

  const song = params.get("song");
  if (song !== null && SONGS.some(candidate => candidate.id === song)) {
    state.songId = song;
    state.touring = false;
  }

  const lines = params.get("lines");
  if (lines !== null && lines in TIMINGS) {
    state.timing = lines;
    state.touring = false;
  }

  const theme = params.get("theme");
  const starter = THEMES.find(candidate => candidate.id === theme);
  if (starter !== undefined) {
    state.themeId = starter.id;
    state.themeText = starter.css;
  }

  const offset = Number(params.get("offset"));
  if (Number.isFinite(offset) && params.has("offset")) {
    state.offsetMs = Math.round(clamp(offset, -2000, 2000) / 25) * 25;
  }

  if (params.has("passive")) state.passiveScroll = params.get("passive") === "1";
  if (params.has("scroll")) state.viewScroll = params.get("scroll") === "1";
  if (params.has("page")) state.pageRules = params.get("page") === "1";
}

/**
 * The address bar as the one copy of the state worth sharing. Imported lyrics, a dropped file and a
 * hand written theme are all left out: they are kilobytes each, and a link nobody can send is worse
 * than a link that carries less than everything. What the chapters chose on the reader's behalf is
 * left out too, so a shared link starts the tour rather than pinning wherever it was.
 */
function writeStateToUrl() {
  const params = new URLSearchParams();
  if (!state.touring && state.audio === null) params.set("song", state.songId);
  if (!state.touring && state.importedLyrics === null) params.set("lines", state.timing);
  if (state.themeId !== null && state.themeId !== DEFAULTS.themeId) params.set("theme", state.themeId);
  if (state.offsetMs !== DEFAULTS.offsetMs) params.set("offset", String(state.offsetMs));
  if (state.passiveScroll !== DEFAULTS.passiveScroll) params.set("passive", state.passiveScroll ? "1" : "0");
  if (state.viewScroll !== DEFAULTS.viewScroll) params.set("scroll", state.viewScroll ? "1" : "0");
  if (state.pageRules !== DEFAULTS.pageRules) params.set("page", state.pageRules ? "1" : "0");

  const query = params.toString();
  history.replaceState(null, "", query === "" ? location.pathname : `${location.pathname}?${query}`);
}

// -- Applying it --------------------------------------------

/**
 * Renders the view again against the last player snapshot. `tickOptions` and most theme settings are
 * read by the next tick rather than causing one, and the element only ticks while the media element
 * is playing, so a control moved during a pause would otherwise do nothing visible until playback
 * resumed. `renderer` is how that door is reachable.
 */
function retick() {
  view.renderer?.retickFromPlaybackClock((eventCreationTime, isPlaying) => ({
    ...view.tickOptions,
    eventCreationTime,
    isPlaying,
  }));
}

let pendingStartS = 0;

function applyAudio() {
  const url = state.audio?.url ?? `/generated/${state.songId}.wav`;
  if (url === applied.audioUrl) {
    if (pendingStartS > 0) player.currentTime = pendingStartS;
    pendingStartS = 0;
    return;
  }

  const wasPlaying = !player.paused;
  applied.audioUrl = url;
  player.src = url;
  player.load();

  // Always written, even to zero: a paused view only moves off the old song's position when the
  // clock it follows reports a seek.
  const startS = pendingStartS;
  pendingStartS = 0;
  player.addEventListener("loadedmetadata", () => (player.currentTime = startS), { once: true });
  if (wasPlaying) player.play().catch(error => report(songStatus, error.message, "bad"));
}

function applyLyrics() {
  const lyrics = state.importedLyrics ?? builtInLyrics();
  if (lyrics === applied.lyrics) return;

  // Options first: they are read by the next build, and writing lyrics is what builds.
  view.lyricsOptions = { noLyrics: state.importedLyrics === null && state.timing === "empty" };
  view.lyrics = lyrics;
  applied.lyrics = lyrics;

  paintDecorationButtons();

  const json = JSON.stringify(lyrics, null, 2);
  lyricsArray.textContent =
    json.length > ARRAY_PREVIEW_LIMIT
      ? `${json.slice(0, ARRAY_PREVIEW_LIMIT)}\n\nCut here. ${lyrics.length} lines in total.`
      : json;
}

function applyTheme() {
  if (state.themeText === applied.theme) return;
  view.theme = state.themeText;
  applied.theme = state.themeText;
  // Where the active line sits is read while the view measures itself, and a theme write does not
  // re-measure: most settings do not move anything. So the measurement is asked for here.
  view.renderer?.relayout();
}

function applyState() {
  applyAudio();
  applyLyrics();
  applyTheme();

  view.tickOptions = {
    lyricOffset: state.offsetMs / 1000,
    passiveScrollEnabled: state.passiveScroll,
  };

  document.documentElement.dataset.pageRules = state.pageRules ? "on" : "off";
  document.documentElement.dataset.viewScroll = state.viewScroll ? "on" : "off";
  retick();
}

function paintSlider(input, spoken) {
  const min = Number(input.min);
  input.style.setProperty("--seek-progress", String((Number(input.value) - min) / (Number(input.max) - min)));
  input.setAttribute("aria-valuetext", spoken);
}

function currentTheme() {
  return THEMES.find(theme => theme.id === state.themeId);
}

function paintControls() {
  const offsetLabel = `${state.offsetMs > 0 ? "+" : ""}${state.offsetMs} ms`;
  offsetInput.value = String(state.offsetMs);
  offsetValue.textContent = offsetLabel;
  paintSlider(offsetInput, offsetLabel);

  passiveScrollInput.checked = state.passiveScroll;
  viewScrollInput.checked = state.viewScroll;
  pageRulesInput.checked = state.pageRules;

  for (const button of songList.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(state.audio === null && button.value === state.songId));
  }
  paintSongSelect();

  for (const button of themeList.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.value === state.themeId));
  }
  themeSummary.textContent = currentTheme()?.summary ?? "Edited. Pick a theme to start over.";

  for (const radio of timingFieldset.querySelectorAll("input[type=radio]")) {
    radio.checked = state.importedLyrics === null && radio.value === state.timing;
  }
  slideSegment(timingFieldset);

  timingHint.textContent =
    state.importedLyrics === null
      ? TIMINGS[state.timing].hint
      : `Showing ${state.importedName}. Pick a timing to go back to the built-in song.`;

  // Never while the caret might be in it: the editor is the only control whose value a reader is
  // mid-way through typing.
  if (themeEditor.value !== state.themeText) {
    themeEditor.value = state.themeText;
    paintThemeEditor();
  }

  paintCaption();
}

function paintCaption() {
  const label = state.importedLyrics === null ? TIMINGS[state.timing].label : `Imported ${state.importedName}`;
  morphText(captionLabel, label);
  morphText(captionSong, state.audio?.label ?? SONGS.find(song => song.id === state.songId).title);
  morphText(captionTheme, currentTheme()?.title ?? "Edited theme");
}

let swapTimer = 0;

/**
 * The one way state reaches the element. A change the reader would see as a different song, a
 * different timing or a different theme cross fades the view, and everything that lands while it is
 * faded out goes in with the same swap, so a scroll across two chapters is one fade rather than two.
 */
function commit({ fade = false } = {}) {
  paintControls();
  writeStateToUrl();
  if (swapTimer !== 0) return;
  if (!fade || reducedMotion.matches) {
    applyState();
    return;
  }

  frame.dataset.swapping = "";
  swapTimer = setTimeout(() => {
    swapTimer = 0;
    applyState();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (swapTimer === 0) frame.removeAttribute("data-swapping");
      })
    );
  }, SWAP_OUT_MS);
}

// -- Songs --------------------------------------------

function renderSongs() {
  songList.replaceChildren(
    ...SONGS.map(song => {
      const button = document.createElement("button");
      button.className = "song";
      button.type = "button";
      button.value = song.id;

      const title = document.createElement("b");
      title.textContent = song.title;
      const summary = document.createElement("span");
      summary.textContent = song.summary;

      button.append(title, summary);
      button.addEventListener("click", () => chooseSong(song.id));
      return button;
    })
  );

  songSelect.replaceChildren(...SONGS.map(song => new Option(song.title, song.id)));
  songSelect.addEventListener("change", () => chooseSong(songSelect.value));
}

function paintSongSelect() {
  let own = songSelect.querySelector("option[data-own]");
  if (state.audio === null) {
    own?.remove();
    songSelect.value = state.songId;
    return;
  }
  if (own === null) {
    own = new Option("", "");
    own.dataset.own = "";
    songSelect.prepend(own);
  }
  own.textContent = state.audio.label;
  songSelect.value = "";
}

function chooseSong(songId, startMs) {
  releaseAudio();
  state.songId = songId;
  state.touring = false;
  pendingStartS = (startMs ?? 0) / 1000;
  report(songStatus, "");
  commit({ fade: applied.audioUrl !== `/generated/${songId}.wav` });
}

function releaseAudio() {
  if (state.audio?.objectUrl) URL.revokeObjectURL(state.audio.objectUrl);
  state.audio = null;
}

function loadAudio(url, label, objectUrl) {
  releaseAudio();
  state.audio = { url, label, objectUrl };
  state.touring = false;
  report(
    songStatus,
    state.importedLyrics === null
      ? `Playing ${label}. The lyrics are still the built-in song's, so import a lyrics file to match.`
      : `Playing ${label}.`,
    "good"
  );
  commit();
}

// -- Lyrics --------------------------------------------

async function importLyrics(text, label) {
  const parsers = await loadParsers();
  if (parsers === null) {
    report(
      lyricsStatus,
      `Couldn't load ${PARSERS_SPECIFIER}, so files can't be read right now. The rest of the page still works.`,
      "bad"
    );
    revealLyricsStatus();
    return;
  }

  let read;
  try {
    read = parseLyrics(parsers, text, player.duration * 1000);
  } catch (error) {
    report(lyricsStatus, error.message, "bad");
    revealLyricsStatus();
    return;
  }

  state.importedLyrics = read.lyrics;
  state.importedName = label;
  state.touring = false;
  report(lyricsStatus, `Read ${label} as ${read.format}. ${read.lyrics.length} lines.`, "good");
  commit({ fade: true });
}

/** A file dropped or pasted anywhere lands here, so a failure is brought to where it is explained. */
function revealLyricsStatus() {
  lyricsStatus.scrollIntoView({ block: "nearest" });
}

function readAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`${file.name} could not be read.`));
    reader.readAsText(file);
  });
}

function isAudio(file) {
  return file.type.startsWith("audio/") || AUDIO_EXTENSIONS.test(file.name);
}

async function acceptFile(file) {
  if (isAudio(file)) {
    const objectUrl = URL.createObjectURL(file);
    loadAudio(objectUrl, file.name, objectUrl);
    return;
  }

  try {
    await importLyrics(await readAsText(file), file.name);
  } catch (error) {
    report(lyricsStatus, error.message, "bad");
  }
}

function pickFile(accept, onPicked) {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file !== undefined) onPicked(file);
  });
  input.click();
}

// -- Theme --------------------------------------------

function presetSample(themeId) {
  const sample = document.createElement("span");
  sample.className = "preset__sample";
  sample.setAttribute("aria-hidden", "true");

  const sung = document.createElement("span");
  if (themeId === "karaoke") {
    const past = document.createElement("i");
    past.textContent = "The";
    sung.append(past, " kettle");
  } else {
    sung.textContent = "The kettle";
  }
  const next = document.createElement("span");
  next.textContent = "at six";
  sample.append(sung, next);
  return sample;
}

function renderThemes() {
  themeList.replaceChildren(
    ...THEMES.map(theme => {
      const button = document.createElement("button");
      button.className = "preset";
      button.type = "button";
      button.value = theme.id;
      button.dataset.theme = theme.id;

      const name = document.createElement("span");
      name.className = "preset__name";
      name.textContent = theme.title;

      button.append(presetSample(theme.id), name);
      button.addEventListener("click", () => {
        if (state.themeId === theme.id && state.themeText === theme.css) return;
        state.themeId = theme.id;
        state.themeText = theme.css;
        commit({ fade: true });
        describeTheme(theme.css);
      });
      return button;
    })
  );
}

function describeTheme(css) {
  const settings = [...parseThemeConfig(css).keys()];
  if (settings.length === 0) {
    report(themeStatus, "No blyrics-* settings, so all of them use their defaults.");
    return;
  }
  report(themeStatus, `${settings.length} setting${settings.length === 1 ? "" : "s"}: ${settings.join(", ")}.`);
}

let parseThemeConfig = () => new Map();
let themeTimer = 0;

/** Whatever the input is doing to its own box, the layer behind it does too. */
function matchThemeEditor() {
  themePaint.style.setProperty("--editor-gutter", `${themeEditor.offsetWidth - themeEditor.clientWidth}px`);
  themePaint.scrollTop = themeEditor.scrollTop;
  themePaint.scrollLeft = themeEditor.scrollLeft;
}

/**
 * Repainted on every keystroke rather than debounced with the apply: putting a stylesheet into the
 * document is worth waiting a moment for, and the text a reader is looking at while they type is
 * not.
 */
function paintThemeEditor() {
  // The trailing newline belongs to the layer rather than to the sheet. A textarea gives its final
  // one a line and a <pre> does not, and a sheet that ends in one would scroll a line short.
  themePaint.replaceChildren(highlightStyles(`${themeEditor.value}\n`));
  themeEditor.dataset.painted = "";
  matchThemeEditor();
}

function wireThemeEditor() {
  themeEditor.addEventListener("scroll", matchThemeEditor, { passive: true });

  // The drag handle and a change of width both decide whether the input overflows, and neither of
  // them raises input.
  new ResizeObserver(matchThemeEditor).observe(themeEditor);

  themeEditor.addEventListener("input", () => {
    paintThemeEditor();
    state.themeText = themeEditor.value;
    state.themeId = THEMES.find(theme => theme.css === themeEditor.value)?.id ?? null;

    // Debounced, because a theme write puts a whole stylesheet into the document and re-measures the
    // view, and doing that on every keystroke is felt.
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => {
      commit();
      describeTheme(state.themeText);
    }, THEME_APPLY_DELAY_MS);
  });
}

// -- The reference --------------------------------------------

function renderReference() {
  document.getElementById("package-version").textContent = PACKAGE.version;
  document.getElementById("npm-link").href = PACKAGE.npmHref;
  document.getElementById("repo-link").href = PACKAGE.repoHref;
  document.getElementById("docs-link").href = PACKAGE.docsHref;
  document.getElementById("renderer-guide-link").href = `${PACKAGE.docsHref}/renderer`;
  document.getElementById("parsers-guide-link").href = `${PACKAGE.docsHref}/parsers`;

  renderTerms(
    document.getElementById("properties-list"),
    PROPERTIES.map(row => ({
      term: row.member,
      meta: row.writable ? row.type : `${row.type}, read-only`,
      definition: row.summary,
    }))
  );

  renderTerms(
    document.getElementById("attributes-list"),
    ATTRIBUTES.map(row => ({ term: row.attribute, meta: `writes .${row.writes}`, definition: row.summary }))
  );

  renderTerms(
    document.getElementById("events-list"),
    EVENTS.map(row => ({ term: row.event, meta: row.detail, definition: row.summary }))
  );

  renderTerms(
    document.getElementById("class-names-list"),
    CLASS_NAMES.map(row => ({ term: `.${row.value}`, meta: row.constant, definition: row.summary }))
  );

  renderTerms(
    document.getElementById("theme-settings-list"),
    THEME_SETTINGS.map(row => ({
      term: row.key,
      meta: row.rebuilds ? `${row.fallback}, rebuilds the lines` : row.fallback,
      definition: row.summary,
    }))
  );

  renderTerms(
    document.getElementById("custom-properties-list"),
    CUSTOM_PROPERTIES.map(row => ({ term: row.property, definition: row.summary }))
  );

  renderTerms(
    document.getElementById("stylesheets-list"),
    STYLESHEETS.map(row => ({ term: `styles/${row.file}`, definition: row.summary }))
  );
}

function wireReferenceTabs() {
  referenceTabs.addEventListener("change", event => {
    for (const panel of document.querySelectorAll("[data-panel]")) {
      panel.hidden = panel.dataset.panel !== event.target.value;
    }
    slideSegment(referenceTabs);
  });
}

// -- The two proofs --------------------------------------------

function describeElement(element) {
  if (element === null) return "null";
  const id = element.id ? `#${element.id}` : "";
  return `<${element.localName}${id}>`;
}

function describeSettings(settings) {
  if (settings.size === 0) return "nothing";
  return [...settings].map(([key, value]) => `${key} = ${value}`).join(", ");
}

function reportUpgrade(themeStyleId) {
  const askedFor = parseThemeConfig(beforeUpgrade.themeAttribute);
  const themeStyleElement = document.getElementById(themeStyleId);
  const inForce = parseThemeConfig(themeStyleElement?.textContent ?? "");

  const themeArrived = askedFor.size > 0 && [...askedFor].every(([key, value]) => inForce.get(key) === value);
  const upgraded = view.constructor.name !== beforeUpgrade.constructorName;
  const sourceArrived = view.mediaElement === player;
  const startedUndefined = !beforeUpgrade.registered && !beforeUpgrade.hasAccessors;

  renderReadout(document.getElementById("upgrade-readout"), [
    {
      label: "Defined when the HTML was read",
      value: beforeUpgrade.registered ? "yes" : "no",
      state: startedUndefined ? undefined : "fail",
    },
    {
      label: "Class before and after the script loads",
      value: `${beforeUpgrade.constructorName} -> ${view.constructor.name}`,
      state: upgraded ? undefined : "fail",
    },
    {
      label: "source attribute, after the script loads",
      value: `${beforeUpgrade.sourceAttribute} -> ${describeElement(view.mediaElement)}`,
      state: sourceArrived ? undefined : "fail",
    },
    {
      label: `theme attribute, read from #${themeStyleId}`,
      value: describeSettings(inForce),
      state: themeArrived ? undefined : "fail",
    },
    { label: "view.status", value: view.status, state: view.status === "rendering" ? undefined : "fail" },
  ]);

  const held = startedUndefined && upgraded && sourceArrived && themeArrived;
  const verdict = document.getElementById("upgrade-verdict");
  verdict.dataset.state = held ? "pass" : "fail";
  verdict.textContent = held
    ? "Yes. Both attributes applied after the script loaded."
    : "No. The rows below show what was found.";
}

function reportCascade(lineClass, lyricsClass) {
  const pageRulesApply = document.documentElement.dataset.pageRules === "on";
  const container = view.querySelector(`.${lyricsClass}`);

  // A registered custom property has a computed value on every element, whatever the element sets.
  // An unregistered one computes to nothing. So the initial value coming back off <body> is the
  // @property registration in the package's lyrics.css answering from document level.
  const registration = getComputedStyle(document.body).getPropertyValue("--lyric-transition-amount-start").trim();

  renderReadout(document.getElementById("cascade-readout"), [
    { label: "view.shadowRoot", value: String(view.shadowRoot), state: view.shadowRoot === null ? undefined : "fail" },
    {
      label: "Lines your CSS can select",
      value: String(document.querySelectorAll(`.${lineClass}`).length),
    },
    {
      label: "@property registered, read on <body>",
      value: registration === "" ? "not registered" : registration,
      state: registration === "" ? "fail" : undefined,
    },
    {
      label: `letter-spacing on .${lyricsClass}`,
      value: container === null ? "no container" : getComputedStyle(container).letterSpacing,
      state: pageRulesApply ? undefined : "off",
    },
  ]);
}

// -- Events --------------------------------------------

function describeDetail(type, detail) {
  if (type === "braccato:lyrics-loaded") return `lineCount ${detail.lineCount}, syncType "${detail.syncType}"`;
  if (type === "braccato:line-click") return `timeS ${detail.timeS.toFixed(2)}`;
  if (type === "braccato:scroll-state") return `userScrolling ${detail.userScrolling}`;
  return `phase "${detail.phase}": ${detail.error.message}`;
}

function logEvent(event) {
  const entry = document.createElement("li");
  if (event.type === "braccato:error") entry.dataset.phase = "error";

  const stamp = document.createElement("span");
  stamp.className = "log__at";
  stamp.textContent = formatClock(player.currentTime);

  const name = document.createElement("b");
  name.textContent = event.type.slice("braccato:".length);

  const detail = document.createElement("span");
  detail.className = "log__detail";
  detail.textContent = describeDetail(event.type, event.detail);

  entry.append(stamp, name, detail);
  eventLog.prepend(entry);
  while (eventLog.childElementCount > LOG_LIMIT) eventLog.lastElementChild.remove();

  // A theme that will not apply is the one error a reader of this page can cause, so it is answered
  // where they caused it rather than only in the log.
  if (event.type === "braccato:error" && event.detail.phase === "theme") {
    report(themeStatus, event.detail.error.message, "bad");
  }
}

// -- Transport --------------------------------------------

function formatClock(seconds) {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

let scrubbing = false;

function paintTransport() {
  const duration = Number.isFinite(player.duration) ? player.duration : 0;
  const progress = duration === 0 ? 0 : player.currentTime / duration;

  elapsedOutput.textContent = formatClock(player.currentTime);
  seekInput.style.setProperty("--seek-progress", String(progress));
  if (!scrubbing) {
    seekInput.value = String(player.currentTime);
    seekInput.setAttribute("aria-valuetext", formatClock(player.currentTime));
  }
}

function followClock() {
  paintTransport();
  if (!player.paused) requestAnimationFrame(followClock);
}

function adoptDuration() {
  if (!Number.isFinite(player.duration)) return;
  seekInput.max = String(player.duration);
  durationOutput.textContent = formatClock(player.duration);
  paintTransport();
}

function paintPlaying() {
  const playing = String(!player.paused);
  heroPlay.dataset.playing = playing;
  playButton.dataset.playing = playing;
  playButton.setAttribute("aria-label", player.paused ? "Play" : "Pause");
  morphText(heroPlayLabel, player.paused ? "Play the demo" : "Pause the demo");
}

/**
 * The one way this page starts the song, so the buttons, the Space key and a click on a line fail the
 * same way. The label is not written here: `play` is what paints it, and a request the browser
 * refuses never fires one.
 */
function startPlayback() {
  if (!player.paused) return;
  player.play().catch(error => {
    stageStatus.hidden = false;
    stageStatus.dataset.failed = "";
    stageStatus.textContent = `The browser blocked playback: ${error.message}`;
  });
}

function togglePlayback() {
  if (player.paused) startPlayback();
  else player.pause();
}

function wireTransport() {
  // Read now as well as waited for: the track is preloaded from the markup, so its metadata is
  // often already in by the time this module has finished importing the package.
  player.addEventListener("loadedmetadata", adoptDuration);
  adoptDuration();

  heroPlay.addEventListener("click", togglePlayback);
  playButton.addEventListener("click", togglePlayback);

  document.addEventListener("keydown", event => {
    if (event.code !== "Space" || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (
      event.target instanceof Element &&
      event.target.closest("input, textarea, select, button, a, summary, [contenteditable]")
    ) {
      return;
    }
    event.preventDefault();
    togglePlayback();
  });

  player.addEventListener("play", () => {
    paintPlaying();
    // Pressing play after reading ahead is the same request the resume button makes, so it is
    // answered the same way. The module does this itself for unsynced lyrics and only for those.
    resumeAutoscroll();
    followClock();
  });
  player.addEventListener("pause", () => {
    paintPlaying();
    paintTransport();
  });
  player.addEventListener("seeked", paintTransport);
  player.addEventListener("error", () => {
    report(songStatus, `Couldn't load that audio. ${player.error?.message ?? "No reason given."}`, "bad");
  });

  seekInput.addEventListener("pointerdown", () => {
    scrubbing = true;
  });
  seekInput.addEventListener("pointerup", () => {
    scrubbing = false;
  });
  seekInput.addEventListener("input", () => {
    player.currentTime = Number(seekInput.value);
    paintTransport();
  });
}

// -- Autoscroll --------------------------------------------

/**
 * Whether the module wants the way back offered. This page keeps no opinion of its own about whether
 * the reader has scrolled away: the renderer already tracks it, and `setResumeAffordanceVisible` is
 * how it says so. Written rather than toggled, because the call is not edge triggered.
 */
function showResumeAffordance(visible) {
  resumeButton.toggleAttribute("data-shown", visible);
}

/**
 * Autoscroll follows the song again. Putting the button away and pulling the view back to the active
 * line both happen inside a tick, and a paused page has no frame loop to deliver one, so the retick
 * is what makes this visible while the clock is stopped.
 */
function resumeAutoscroll() {
  view.renderer?.resumeAutoscroll();
  retick();
}

// -- Chapters --------------------------------------------

// What each chapter shows while the tour is running. A chapter with no entry leaves the view alone.
const SCENES = {
  intro: { songId: "kettle", timing: "syllables" },
  syllables: { songId: "kettle", timing: "syllables" },
  lines: { songId: "ring-road", timing: "lines" },
  duets: { songId: "kettle", timing: "syllables", startMs: 9000 },
  themes: { songId: "the-steps", timing: "syllables" },
  formats: { songId: "the-choir", timing: "syllables" },
};

// The rail names the reference once, and the light DOM section belongs to it.
const RAIL_TARGET = { "light-dom": "reference" };

let chapter = "intro";
let reading = "intro";
// Set while the page travels to a chapter picked on the rail, so the chapters it passes on the way
// do not each swap the song.
let jumping = false;

function paintRail() {
  const target = RAIL_TARGET[chapter] ?? chapter;
  let current = null;
  for (const link of rail.querySelectorAll("a")) {
    const on = link.dataset.go === target;
    if (on) {
      link.setAttribute("aria-current", "step");
      current = link;
    } else {
      link.removeAttribute("aria-current");
    }
  }
  slide(rail, current);
}

function enterChapter(name) {
  reading = name;
  if (jumping || name === chapter) return;
  chapter = name;
  stage.dataset.chapter = name;
  paintRail();

  const scene = SCENES[name];
  if (!state.touring || scene === undefined) return;
  if (state.songId === scene.songId && state.timing === scene.timing) return;

  if (state.songId !== scene.songId) pendingStartS = (scene.startMs ?? 0) / 1000;
  state.songId = scene.songId;
  state.timing = scene.timing;
  commit({ fade: true });
}

function wireChapters() {
  // A band one percent tall across the middle of the story, or across the part of it the stage does
  // not cover on a narrow screen. Whatever chapter is crossing it is the one being read.
  const observer = new IntersectionObserver(
    entries => {
      for (const entry of entries) if (entry.isIntersecting) enterChapter(entry.target.dataset.chapter);
    },
    { rootMargin: matchMedia(NARROW).matches ? "-72% 0px -27% 0px" : "-50% 0px -49% 0px" }
  );
  for (const section of document.querySelectorAll(".story [data-chapter]")) observer.observe(section);

  for (const link of rail.querySelectorAll("a")) {
    link.addEventListener("click", () => {
      jumping = true;
      slide(rail, link);
      const arrive = () => {
        if (!jumping) return;
        jumping = false;
        enterChapter(reading);
      };
      addEventListener("scrollend", arrive, { once: true });
      setTimeout(arrive, 1200);
    });
  }

  for (const chip of document.querySelectorAll("[data-seek]")) {
    chip.addEventListener("click", () => {
      chooseSong("kettle", Number(chip.dataset.seek));
      startPlayback();
    });
  }

  const reslide = () => {
    paintRail();
    for (const fieldset of document.querySelectorAll(".seg")) slideSegment(fieldset);
  };
  addEventListener("resize", reslide);
  document.fonts.ready.then(reslide);
}

// -- Files arriving from outside --------------------------------------------

function carriesFiles(event) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function wireDropAndPaste() {
  // A counter rather than a flag: dragleave fires every time the pointer crosses a child boundary,
  // and a flag makes the overlay flicker over anything with children in it.
  let depth = 0;

  document.addEventListener("dragenter", event => {
    if (!carriesFiles(event)) return;
    depth += 1;
    dropzone.hidden = false;
  });

  document.addEventListener("dragleave", () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) dropzone.hidden = true;
  });

  document.addEventListener("dragover", event => {
    if (carriesFiles(event)) event.preventDefault();
  });

  document.addEventListener("drop", event => {
    if (!carriesFiles(event)) return;
    event.preventDefault();
    depth = 0;
    dropzone.hidden = true;
    for (const file of event.dataTransfer.files) acceptFile(file);
  });

  document.addEventListener("paste", event => {
    // Somewhere a caret could be is somewhere the paste already belongs.
    if (event.target instanceof Element && event.target.closest("input, textarea, [contenteditable]")) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (text.trim().length < 8) return;
    event.preventDefault();
    importLyrics(text, "the clipboard");
  });
}

// -- Wiring the rest --------------------------------------------

function wireControls(lineClass, lyricsClass) {
  songFileButton.addEventListener("click", () => pickFile("audio/*", acceptFile));
  lyricsFileInput.addEventListener("change", () => {
    const file = lyricsFileInput.files?.[0];
    if (file !== undefined) acceptFile(file);
    lyricsFileInput.value = "";
  });

  songUrlButton.addEventListener("click", () => {
    const typed = songUrlInput.value.trim();
    if (typed === "") return;

    let parsed;
    try {
      parsed = new URL(typed, location.href);
    } catch {
      report(songStatus, "That isn't a valid URL.", "bad");
      return;
    }

    if (!AUDIO_URL_SCHEMES.has(parsed.protocol)) {
      report(songStatus, "Only http and https links work here.", "bad");
      return;
    }

    loadAudio(parsed.href, parsed.pathname.split("/").pop() || typed);
  });

  songUrlInput.addEventListener("keydown", event => {
    if (event.key === "Enter") songUrlButton.click();
  });

  lyricsImportButton.addEventListener("click", () => {
    const text = lyricsTextArea.value;
    if (text.trim() === "") {
      report(lyricsStatus, "Paste a lyrics file into the box first.", "bad");
      return;
    }
    importLyrics(text, "what you pasted");
  });

  timingFieldset.addEventListener("change", event => {
    state.timing = event.target.value;
    state.importedLyrics = null;
    state.importedName = "";
    state.touring = false;
    report(lyricsStatus, "");
    commit({ fade: true });
  });

  offsetInput.addEventListener("input", () => {
    state.offsetMs = Number(offsetInput.value);
    commit();
  });

  passiveScrollInput.addEventListener("change", () => {
    state.passiveScroll = passiveScrollInput.checked;
    commit();
  });

  viewScrollInput.addEventListener("change", () => {
    state.viewScroll = viewScrollInput.checked;
    commit();
    // A scrollbar appearing takes width off every line, so the view re-reads a layout that just
    // moved under it.
    view.renderer?.relayout();
  });

  pageRulesInput.addEventListener("change", () => {
    state.pageRules = pageRulesInput.checked;
    commit();
    reportCascade(lineClass, lyricsClass);
    // Tightening the tracking changes how wide every line is, so the view re-reads the layout that
    // this page just moved under it.
    view.renderer?.relayout();
  });

  injectRomanizationsButton.addEventListener("click", () => toggleKinds(["romanization"]));
  injectTranslationsButton.addEventListener("click", () => toggleKinds(["translation"]));
  injectBothButton.addEventListener("click", toggleBothDecorations);

  animateDecorationsInput.addEventListener("change", () => {
    view.style.setProperty("--blyrics-animate-decoration-entry", animateDecorationsInput.checked ? "1" : "0");
  });

  resumeButton.addEventListener("click", resumeAutoscroll);

  // The element never tells its renderer that someone scrolled the view, so autoscroll would keep
  // pulling the song back under anyone reading ahead. `renderer` is published for reaching past the
  // element exactly like this.
  frame.addEventListener("scroll", () => view.renderer?.noteUserScroll(), { passive: true });
}

// -- Decorations --------------------------------------------

const DECORATION_FADE_MS = 250;

const DECORATION_KINDS = {
  romanization: {
    selector: ".blyrics--romanized",
    inject: (line, pair) => injectRomanization(document, line.lyricElement, line, pair.roman),
  },
  translation: {
    selector: ".blyrics--translated",
    inject: (line, pair) => injectTranslation(document, line.lyricElement, pair.trans),
  },
};

function liveDecorations(selector) {
  return [...document.querySelectorAll(selector)].filter(el => !el.classList.contains("blyrics--leaving"));
}

function decorationSelector(kinds) {
  return kinds.map(kind => DECORATION_KINDS[kind].selector).join(", ");
}

function paintDecorationButton(button, shown, noun) {
  button.setAttribute("aria-pressed", String(shown));
  morphText(button.querySelector("[data-label]"), `${shown ? "Hide" : "Show"} ${noun}`);
}

function paintDecorationButtons() {
  const roman = liveDecorations(DECORATION_KINDS.romanization.selector).length > 0;
  const trans = liveDecorations(DECORATION_KINDS.translation.selector).length > 0;
  paintDecorationButton(injectRomanizationsButton, roman, "romanizations");
  paintDecorationButton(injectTranslationsButton, trans, "translations");
  paintDecorationButton(injectBothButton, roman && trans, "both");
}

function repositionDecorations() {
  view.renderer?.scheduleLyricPositionUpdate(
    () => true,
    () => {}
  );
}

function showDecorations(kinds) {
  (view.renderer?.lines ?? []).forEach((line, index) => {
    const el = line.lyricElement;
    if (!el || el.dataset.instrumental) return;
    const pair = DEMO_DECORATIONS[index % DEMO_DECORATIONS.length];
    kinds.forEach(kind => DECORATION_KINDS[kind].inject(line, pair));
  });
  repositionDecorations();
  paintDecorationButtons();
}

function hideDecorations(kinds) {
  const leaving = liveDecorations(decorationSelector(kinds));
  if (leaving.length === 0) return;

  if (!animateDecorationsInput.checked) {
    leaving.forEach(el => el.remove());
    repositionDecorations();
    paintDecorationButtons();
    return;
  }

  leaving.forEach(el => el.classList.add("blyrics--leaving"));
  paintDecorationButtons();
  setTimeout(() => {
    leaving.forEach(el => el.remove());
    repositionDecorations();
  }, DECORATION_FADE_MS);
}

function toggleKinds(kinds) {
  if (liveDecorations(decorationSelector(kinds)).length > 0) hideDecorations(kinds);
  else showDecorations(kinds);
}

function toggleBothDecorations() {
  const roman = liveDecorations(DECORATION_KINDS.romanization.selector).length > 0;
  const trans = liveDecorations(DECORATION_KINDS.translation.selector).length > 0;
  if (roman && trans) hideDecorations(["romanization", "translation"]);
  else showDecorations(["romanization", "translation"]);
}

// -- Boot --------------------------------------------

async function boot() {
  const [, { CUSTOM_THEME_STYLE_ID, LINE_CLASS, LYRICS_CLASS }, themeSettings, core] = await Promise.all([
    import("@braccato/core/element"),
    import("@braccato/core/constants"),
    import("@braccato/core/themeSettings"),
    import("@braccato/core"),
  ]);
  parseThemeConfig = themeSettings.parseThemeConfig;
  injectTranslation = core.injectTranslation;
  injectRomanization = core.injectRomanization;

  for (const type of ["braccato:lyrics-loaded", "braccato:line-click", "braccato:scroll-state", "braccato:error"]) {
    view.addEventListener(type, logEvent);
  }

  // The clock has already moved by the time this fires, so the song starts from the line rather than
  // from where it was. An alt-clicked word arrives here too: the module tells its host that a seek
  // happened and nothing about which kind it was.
  view.addEventListener("braccato:line-click", startPlayback);

  // The renderer looks for the nearest scrolling ancestor, and the frame only scrolls when the reader
  // asks for it. `host` answers that question directly, and the element keeps its own seek and
  // scroll-state wiring around it.
  view.host = { getScrollElement: () => frame, setResumeAffordanceVisible: showResumeAffordance };

  readStateFromUrl();
  renderReference();
  renderSnippets();
  renderInstall();
  renderSongs();
  renderThemes();

  // Lyrics before the report, because the cascade panel has nothing to measure without lines, and
  // the theme after it, because the upgrade panel is reading the theme the markup delivered and this
  // page is about to write over it.
  applyLyrics();
  stageStatus.hidden = true;

  reportUpgrade(CUSTOM_THEME_STYLE_ID);

  commit();
  describeTheme(state.themeText);
  reportCascade(LINE_CLASS, LYRICS_CLASS);

  paintInstall();
  paintPlaying();
  paintRail();
  wireControls(LINE_CLASS, LYRICS_CLASS);
  wireThemeEditor();
  wireReferenceTabs();
  wireDropAndPaste();
  wireTransport();
  wireChapters();
  paintTransport();
}

boot().catch(error => {
  stageStatus.hidden = false;
  stageStatus.dataset.failed = "";
  stageStatus.textContent = `Could not load @braccato/core.\n\n${error.message}`;
});

// What this page tells a reader about @braccato/core, in one place so there is one place to change
// it. The page renders its reference and its code samples out of this file, and
// `tooling/check-api-docs.ts` reads the same file and holds every name in it against what
// `pnpm package` actually emitted. A property renamed in the module fails the package build
// rather than quietly leaving a wrong page on the screen.
//
// The prose here is the short answer. `packages/core/README.md` is the package page, and the page
// links to it rather than copying it: this file carries what a consumer needs to write the tag, and
// stops where the reasoning starts. The reasoning lives beside the code it explains, in the module's
// own file headers.

import corePackage from "@braccato/core/package.json" with { type: "json" };

// -- The package --------------------------------------------

// `version` comes straight from the package's own manifest, so the number on the page is the
// artifact's by construction and cannot drift. There is no separate README link, because both of
// these already land on it: npm renders the README as the package page, and GitHub renders it under
// the directory.
export const PACKAGE = {
  name: "@braccato/core",
  version: corePackage.version,
  npmHref: "https://www.npmjs.com/package/@braccato/core",
  repoHref: "https://github.com/better-lyrics/braccato/tree/master/packages/core",
  docsHref: "https://docs.betterlyrics.org/braccato",
};

export const INSTALLERS = [
  { id: "npm", label: "npm", command: "npm install" },
  { id: "pnpm", label: "pnpm", command: "pnpm add" },
  { id: "yarn", label: "yarn", command: "yarn add" },
  { id: "bun", label: "bun", command: "bun add" },
];

// -- Code samples --------------------------------------------

export const SNIPPETS = {
  quickstart: `<audio id="player" src="song.mp3" controls></audio>
<braccato-lyrics source="#player"></braccato-lyrics>

<script type="module">
  import "@braccato/core/element";
  import "@braccato/core/styles/variables.css";
  import "@braccato/core/styles/lyrics.css";
  import "@braccato/core/styles/instrumental.css";

  // You build this array. The package doesn't read lyric files.
  document.querySelector("braccato-lyrics").lyrics = [
    {
      startTimeMs: 3000,
      durationMs: 3000,
      words: "The kettle starts at six",
      parts: [
        { startTimeMs: 3000, durationMs: 375, words: "The " },
        { startTimeMs: 3375, durationMs: 375, words: "ket" },
        { startTimeMs: 3750, durationMs: 375, words: "tle " },
      ],
    },
  ];
</script>`,

  parsers: `// npm install @braccato/parsers
import { detectParser } from "@braccato/parsers";

const view = document.querySelector("braccato-lyrics");
const player = document.querySelector("#player");

const text = await fetch("song.ttml").then(response => response.text());

// Works out whether it is TTML, LRC, SRT, QRC or plain text.
const parser = detectParser(text);
view.lyrics = parser.parse(text, player.duration * 1000);`,

  theme: `view.theme = \`
  /* blyrics-target-scroll-pos-ratio = 0.5; */
  /* blyrics-long-word-threshold = 900; */

  .blyrics-container {
    --blyrics-font-size: 3.5rem;
    --blyrics-lyric-active-color: white;
    --blyrics-lyric-inactive-color: rgb(255 255 255 / 0.25);
  }
\`;`,
};

// -- Properties --------------------------------------------

// `member` is what the check looks for on BraccatoLyricsElement. Every one of these may be written
// before the element is in a document.
export const PROPERTIES = [
  {
    member: "lyrics",
    type: "Lyric[] | null",
    writable: true,
    summary:
      "The song, as an array of lines. null means none was set, and an empty array clears the view. The package doesn't read LRC, TTML or any other format, so you build the array yourself or use @braccato/parsers.",
  },
  {
    member: "lyricsOptions",
    type: "{ loaderVisible?, noLyrics?, language? }",
    writable: true,
    summary:
      "Options for building the lines. Set noLyrics when the array is a placeholder message, not a song, so passive scroll leaves it where it is.",
  },
  {
    member: "source",
    type: "string | HTMLMediaElement | null",
    writable: true,
    summary:
      "A CSS selector or a media element. The selector is looked up when the element connects, so the <audio> has to be in the document already. Put it first, or set this from script.",
  },
  {
    member: "mediaElement",
    type: "HTMLMediaElement | null",
    writable: false,
    summary: "The media element that source points at. null while disconnected, or when the selector matched nothing.",
  },
  {
    member: "currentTime",
    type: "number",
    writable: true,
    summary:
      "The playback position in seconds. Set it to drive the lyrics from your own clock. Once a source is bound, the time comes from the media element and writes are ignored.",
  },
  {
    member: "playing",
    type: "boolean",
    writable: true,
    summary:
      "Whether the clock is running. A paused view animates differently from a playing one. Like currentTime, writes are ignored once a source is bound.",
  },
  {
    member: "tickOptions",
    type: "ElementTickOptions",
    writable: true,
    summary:
      "Per-frame settings: four offsets taken off the clock, whether passive scroll is on, and when the clock was read. They apply from the next frame.",
  },
  {
    member: "theme",
    type: "string",
    writable: true,
    summary:
      "A stylesheet, as a string. Settings go in blyrics-* comments inside it, and the CSS is added to the document head. An empty string resets every setting.",
  },
  {
    member: "host",
    type: "Partial<LyricsRendererHost>",
    writable: true,
    summary:
      "Answers to what the renderer asks the page: is the view on screen, which element scrolls, how to seek, and when to show a resume button. Each has a default. Setting it while connected rebuilds the view.",
  },
  {
    member: "renderer",
    type: "LyricsRenderer | null",
    writable: false,
    summary:
      "The renderer inside the element. It has noteUserScroll, resumeAutoscroll and relayout. The element never calls these for you, so if your page lets people scroll or restyle the view, call them yourself.",
  },
  {
    member: "status",
    type: "ElementStatus",
    writable: false,
    summary:
      "idle, rendering, theme-conflict or no-browsing-context. Errors are dispatched a microtask late, so check this if you started listening afterwards.",
  },
];

// -- Attributes --------------------------------------------

// `attribute` is checked against the element's own observedAttributes at runtime, on the page, and
// against the emitted element.js at build time.
export const ATTRIBUTES = [
  {
    attribute: "source",
    writes: "source",
    summary: "Selector only. Change it to bind somewhere else, remove it to unbind.",
  },
  {
    attribute: "theme",
    writes: "theme",
    summary:
      "A whole stylesheet in an attribute. It works, and it shows that markup written before the module loads still applies, but set the property in real code.",
  },
  {
    attribute: "current-time",
    writes: "currentTime",
    summary:
      "Seconds. A value that isn't a number is ignored, not read as zero, so a half-typed value won't jump back to the start.",
  },
  {
    attribute: "playing",
    writes: "playing",
    summary:
      'A normal boolean attribute: if it is there, the view is playing. playing="false" still counts as playing.',
  },
];

// -- Events --------------------------------------------

export const EVENTS = [
  {
    event: "braccato:lyrics-loaded",
    detail: "{ lineCount, syncType }",
    summary: "Lyrics were applied. A theme change that rebuilds the lines fires it too.",
  },
  {
    event: "braccato:line-click",
    detail: "{ timeS }",
    summary: "A line was clicked. The media element has already seeked when this fires.",
  },
  {
    event: "braccato:scroll-state",
    detail: "{ userScrolling }",
    summary:
      "Autoscroll stopped following the song, or started again. host.setResumeAffordanceVisible hears the same thing. Neither fires until you call renderer.noteUserScroll, which the element doesn't do for you.",
  },
  {
    event: "braccato:error",
    detail: "{ phase, error }",
    summary:
      "Connecting, finding the source, or applying lyrics or a theme failed. Errors inside animation frames aren't sent here, since that could mean sixty a second.",
  },
];

// -- The DOM a theme selects --------------------------------------------

// `constant` is the export in @braccato/core/constants, `value` the class name it holds. Both are
// checked, because a theme selects the value and only the constant is greppable.
export const CLASS_NAMES = [
  { constant: "LYRICS_CLASS", value: "blyrics-container", summary: "The view. One per renderer." },
  { constant: "LINE_CLASS", value: "blyrics--line", summary: 'One line. Each has dir="auto".' },
  { constant: "CURRENT_LYRICS_CLASS", value: "blyrics--active", summary: "The line being sung." },
  { constant: "WORD_CLASS", value: "blyrics--word", summary: "One word. The sweep moves word by word." },
  {
    constant: "BACKGROUND_LYRIC_CLASS",
    value: "blyrics-background-lyric",
    summary: "A background vocal, shown under the line it answers.",
  },
  {
    constant: "USER_SCROLLING_CLASS",
    value: "blyrics-user-scrolling",
    summary: "Set while the reader has scrolled away and autoscroll is paused.",
  },
  {
    constant: "TRANSLATED_LYRICS_CLASS",
    value: "blyrics--translated",
    summary: "A translation added to a line after it was built.",
  },
  {
    constant: "CUSTOM_THEME_STYLE_ID",
    value: "blyrics-custom-style",
    summary: "The id of the <style> element the theme goes into. Read it to give a second view the same stylesheet.",
  },
];

// -- Theme settings --------------------------------------------

// The keys a theme declares in its comments. `key` is checked against the emitted module: every one
// of these is registered somewhere in the engine, and a setting renamed there fails this build.
// `rebuilds` marks the ones the lines are built out of rather than ticked against, which is why
// writing one of those reports braccato:lyrics-loaded again.
export const THEME_SETTINGS = [
  {
    key: "blyrics-target-scroll-pos-ratio",
    fallback: "0.37",
    rebuilds: false,
    summary: "Where the active line sits in the view. 0 is the top, 1 the bottom.",
  },
  {
    key: "blyrics-disable-richsync",
    fallback: "false",
    rebuilds: true,
    summary: "Ignores syllable timing and lights whole lines instead.",
  },
  {
    key: "blyrics-long-word-threshold",
    fallback: "1500",
    rebuilds: true,
    summary: "How long a word has to be held, in milliseconds, before it glows.",
  },
  {
    key: "blyrics-long-word-wrap-threshold",
    fallback: "10",
    rebuilds: true,
    summary: "Held words longer than this many characters are split, so the glow moves across the letters.",
  },
  {
    key: "blyrics-line-synced-animation-delay",
    fallback: "50",
    rebuilds: true,
    summary: "How long a line-synced line takes to light up, in milliseconds.",
  },
  {
    key: "blyrics-swipe-lead-ratio",
    fallback: "0.1",
    rebuilds: false,
    summary: "How far into a word the sweep starts, as a fraction of the word's duration.",
  },
  {
    key: "blyrics-swipe-duration-ratio",
    fallback: "1.6",
    rebuilds: false,
    summary: "How long the sweep runs, as a multiple of the word's duration. Above 1 it runs into the next word.",
  },
  {
    key: "blyrics-lyric-ending-threshold-s",
    fallback: "0.5",
    rebuilds: false,
    summary: "How many seconds before a line ends it starts handing over to the next one.",
  },
  {
    key: "blyrics-early-scroll-consider-s",
    fallback: "0.54",
    rebuilds: false,
    summary:
      "How many seconds ahead a line can trigger a scroll. Being inside the window doesn't scroll on its own, and a line that was already scrolled to doesn't scroll again when it starts. Scrolls never wait for an animation to finish.",
  },
  {
    key: "blyrics-passive-scroll-enabled",
    fallback: "true",
    rebuilds: false,
    summary: "Whether unsynced lyrics drift. Timed songs ignore it.",
  },
  {
    key: "blyrics-passive-scroll-seconds-per-line",
    fallback: "3.5",
    rebuilds: false,
    summary: "How long a drifting view stays on each line.",
  },
  {
    key: "blyrics-line-scroll-duration",
    fallback: "a calc() based on distance from the active line",
    rebuilds: false,
    summary:
      "A CSS time, not a number. Lines further from the active one take longer. A new scroll starts right away and adds to any that are still running.",
  },
];

// -- Custom properties --------------------------------------------

// Checked against the emitted stylesheets, which is the only place a custom property is declared.
export const CUSTOM_PROPERTIES = [
  {
    property: "--blyrics-font-family",
    summary:
      "Replaces the default font stack, which otherwise picks a font for each language in the lyrics and translations.",
  },
  { property: "--blyrics-font-size", summary: "Most other sizes follow it, including the instrumental dots." },
  { property: "--blyrics-line-height", summary: "Unitless, so it scales with the font size." },
  {
    property: "--blyrics-padding",
    summary: "Space above and below each line. Try this before line-height.",
  },
  { property: "--blyrics-lyric-active-color", summary: "The line being sung." },
  { property: "--blyrics-lyric-inactive-color", summary: "Every other line." },
  {
    property: "--blyrics-glow-color",
    summary:
      "The glow behind a word. Every word gets it. To glow only held words, select data-long-word, which is set on words held past blyrics-long-word-threshold. This page does that.",
  },
];

// -- Stylesheets --------------------------------------------

export const STYLESHEETS = [
  {
    file: "variables.css",
    summary: "Every --blyrics-* default. Load it first, since the other two use it.",
  },
  {
    file: "lyrics.css",
    summary: "The container, lines, words and sweep, plus two @property registrations the word animation needs.",
  },
  {
    file: "instrumental.css",
    summary: "The waveform shown during a bar with no singing, and its animation.",
  },
];

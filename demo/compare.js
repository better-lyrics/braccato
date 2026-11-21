// Both renderers, side by side, on one clock. Everything that decides what is drawn (song, timing,
// theme, time) is in the URL, so a screenshot of `?song=kettle&t=12.4` can be taken again later and
// compared against the same moment.
//
//   song    a built-in song id (kettle, ring-road, the-steps, the-choir, stretch, yoake)
//   timing  syllables | lines | plain
//   theme   default | better-lyrics | sustain | karaoke
//   t       seconds to start from (the view is paused there unless `play` is set)
//   play    start playing, muted, from `t`
//   mode    split | dom | rs (the other view is taken off the page, so it does no work)
//   bench   turn off the page's own per-frame work (`pnpm bench` sets it)

import "@braccato/core-dom/styles/variables.css";
import "@braccato/core-dom/styles/lyrics.css";
import "@braccato/core-dom/styles/instrumental.css";
import "@braccato/core-dom/styles/stage.css";
import "./compare.css";

// Imported by path rather than as a dependency: the Rust renderer needs a Rust toolchain to build,
// and the deployed demo does not, so this page is for the dev server only.
import { defineLyricsElement, load } from "../packages/core-rs/js/element.js";
import { buildScore, SONGS } from "./song.js";
import { THEMES } from "./themes.js";

const params = new URLSearchParams(location.search);
const player = document.getElementById("player");
const songSelect = document.getElementById("song");
const timingSelect = document.getElementById("timing");
const themeSelect = document.getElementById("theme");
const playButton = document.getElementById("play");
const seek = document.getElementById("seek");
const clock = document.getElementById("clock");
const panes = document.getElementById("panes");
const stats = document.getElementById("stats");

const state = {
  song: params.get("song") ?? SONGS[0].id,
  timing: params.get("timing") ?? "syllables",
  theme: params.get("theme") ?? "default",
  t: Number.parseFloat(params.get("t") ?? "0") || 0,
  play: params.has("play"),
  mode: params.get("mode") ?? "split",
  layout: params.get("layout") === "stage" ? "stage" : "scroll",
};

panes.dataset.mode = state.mode;
panes.dataset.layout = state.layout;
document.body.dataset.viewScroll = "on";

for (const song of SONGS) songSelect.add(new Option(song.title ?? song.id, song.id));
songSelect.add(new Option("Mixed scripts (test)", "mixed"));
for (const theme of THEMES) themeSelect.add(new Option(theme.title, theme.id));
songSelect.value = state.song;
timingSelect.value = state.timing;
themeSelect.value = state.theme;

// Lines no built-in song has: right-to-left scripts, joining scripts timed by syllable, both
// directions in one line, and scripts with conjuncts, clusters and no spaces. Each entry is a line of
// syllables; a trailing space ends a word. They play over the first song's audio.
const MIXED_LINES = [
  { syllables: ["يا ", "حبي", "بي ", "يا ", "عي", "ني"] },
  { syllables: ["שָׁ", "לוֹם ", "עוֹ", "לָם ", "יָ", "פֶה"], agent: "v2" },
  { syllables: ["I ", "love ", "you ", "حبي", "بي ", "for", "ev", "er"] },
  { syllables: ["سنة ", "2024 ", "جدي", "دة ", "(new ", "year)"], agent: "v2" },
  { syllables: ["मे", "रा ", "दि", "ल ", "तु", "म्हा", "रा ", "है"] },
  { syllables: ["สวัส", "ดี", "ครับ ", "เพื่อน"] },
  { syllables: ["사", "랑", "해", "요 ", "hello ", "👋🏽 ", "world"], agent: "v1000" },
  { syllables: ["Ça ", "va? ", "ὕ", "δωρ ", "Привет ", "мир"] },
];

function mixedSong() {
  const lyrics = [];
  let at = 1000;
  for (const line of MIXED_LINES) {
    const step = 2600 / line.syllables.length;
    const parts = line.syllables.map((words, i) => ({ startTimeMs: at + i * step, durationMs: step, words }));
    lyrics.push({
      startTimeMs: at,
      durationMs: 2800,
      words: line.syllables.join("").trimEnd(),
      parts,
      ...(line.agent ? { agent: line.agent } : {}),
    });
    at += 3200;
  }
  return lyrics;
}

function shape(score, timing) {
  if (timing === "lines")
    return score.map(line => ({
      startTimeMs: line.startTimeMs,
      durationMs: line.durationMs,
      words: line.words,
      isInstrumental: line.isInstrumental,
      romanization: line.romanization,
      translations: line.translations,
    }));
  if (timing === "plain")
    return score
      .filter(line => !line.isInstrumental)
      .map(line => ({
        startTimeMs: 0,
        durationMs: 0,
        words: line.words,
        romanization: line.romanization,
        translations: line.translations,
      }));
  return score;
}

const [, core] = await Promise.all([import("@braccato/core-dom/element"), import("@braccato/core-dom"), load()]).then(
  ([a, b]) => [a, b]
);
defineLyricsElement("braccato-lyrics-rs");

const domView = document.getElementById("dom");
const rsView = document.getElementById("rs");
for (const view of [domView, rsView]) {
  view.addEventListener("braccato:error", event =>
    console.error(`${view.id}: ${event.detail.phase}`, event.detail.error)
  );
}
// On the stage each view reports the box around what is sung, and a plate is drawn behind it.
for (const view of [domView, rsView]) {
  view.layout = state.layout;
  const plate = document.createElement("div");
  plate.className = "plate";
  view.parentElement.prepend(plate);
  view.addEventListener("braccato:stage-layout", ({ detail: { box } }) => {
    plate.style.opacity = box ? "1" : "0";
    if (!box) return;
    const inset = view.offsetTop;
    plate.style.width = `${box.width + 28}px`;
    plate.style.height = `${box.height + 16}px`;
    plate.style.translate = `${view.offsetLeft + box.x - 14}px ${inset + box.y - 8}px`;
  });
}
const shownViews = { dom: [domView], rs: [rsView] }[state.mode] ?? [domView, rsView];
// A hidden view still follows the player, frame by frame, so it leaves the page.
for (const view of [domView, rsView]) if (!shownViews.includes(view)) view.remove();
domView.host = { getScrollElement: () => document.getElementById("view-dom") };
rsView.host = { getScrollElement: () => document.getElementById("view-rs") };

// The DOM renderer shows decorations only when they are injected, as the demo does for a song that
// carries both; the Rust one shows what the lyrics carry, so the two agree.
domView.addEventListener("braccato:lyrics-loaded", () => {
  const lyrics = domView.lyrics ?? [];
  if (!lyrics.some(line => line.romanization && line.translations?.en)) return;
  domView.renderer?.lines.forEach((line, index) => {
    const lyric = lyrics[index];
    const el = line.lyricElement;
    if (!el || el.dataset.instrumental || !lyric?.romanization) return;
    core.injectRomanization(document, el, line, lyric.romanization, lyric.timedRomanization);
    core.injectTranslation(document, el, lyric.translations.en);
  });
  domView.renderer?.scheduleLyricPositionUpdate?.(
    () => true,
    () => {}
  );
});

function apply() {
  const mixed = state.song === "mixed";
  const song = mixed
    ? { ...SONGS[0], songwriters: ["Test Writer", "مؤلف الاختبار"] }
    : (SONGS.find(s => s.id === state.song) ?? SONGS[0]);
  const lyrics = shape(mixed ? mixedSong() : buildScore(song.id).lyrics, state.timing);
  const theme = THEMES.find(t => t.id === state.theme) ?? THEMES[0];
  for (const view of shownViews) {
    view.theme = theme.css;
    view.lyricsOptions = { songwriters: song.songwriters };
    view.lyrics = lyrics;
    view.tickOptions = { countEveryUserScroll: true };
  }
  domView.renderer?.relayout();
  if (!player.src.endsWith(`/generated/${song.id}.wav`)) player.src = `/generated/${song.id}.wav`;
}

function syncUrl() {
  const next = new URLSearchParams({
    song: state.song,
    timing: state.timing,
    theme: state.theme,
    mode: state.mode,
    layout: state.layout,
  });
  history.replaceState(null, "", `?${next}`);
}

songSelect.onchange = () => {
  state.song = songSelect.value;
  apply();
  syncUrl();
};
timingSelect.onchange = () => {
  state.timing = timingSelect.value;
  apply();
  syncUrl();
};
themeSelect.onchange = () => {
  state.theme = themeSelect.value;
  apply();
  syncUrl();
};
playButton.onclick = () => (player.paused ? player.play() : player.pause());
player.addEventListener("play", () => (playButton.textContent = "Pause"));
player.addEventListener("pause", () => (playButton.textContent = "Play"));
player.addEventListener("loadedmetadata", () => (seek.max = String(player.duration)));
seek.oninput = () => (player.currentTime = Number(seek.value));
// The DOM renderer does not watch the scroll element itself; the demo tells it about reader scrolls.
document
  .getElementById("view-dom")
  .addEventListener("scroll", () => domView.renderer?.noteUserScroll?.(), { passive: true });

// `bench` turns off the page's own per-frame work, so a trace shows only the renderer's.
const bench = params.has("bench");

if (!bench)
  (function paintClock() {
    clock.textContent = player.currentTime.toFixed(2);
    if (document.activeElement !== seek) seek.value = String(player.currentTime);
    requestAnimationFrame(paintClock);
  })();

// Frame pacing, for the panel being watched: rAF intervals over the last second.
if (!bench) {
  const intervals = [];
  let last = performance.now();
  (function sample(now) {
    intervals.push(now - last);
    last = now;
    if (intervals.length > 240) intervals.shift();
    const sorted = [...intervals].sort((a, b) => a - b);
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    stats.textContent = `frame p50 ${sorted[sorted.length >> 1]?.toFixed(1)}ms p99 ${p99.toFixed(1)}ms`;
    requestAnimationFrame(sample);
  })(last);
}

apply();
await new Promise(resolve =>
  player.readyState >= 1 ? resolve() : player.addEventListener("loadedmetadata", resolve, { once: true })
);
player.currentTime = state.t;
if (state.play) {
  player.muted = true;
  player.play().catch(() => {});
}
window.compare = { player, domView, rsView, state };

// For screenshot diffs: where the two scroll views are, in CSS pixels, and the page width.
window.compareRects = () => {
  const d = document.getElementById("view-dom").getBoundingClientRect();
  const r = document.getElementById("view-rs").getBoundingClientRect();
  return [d.x, r.x, d.y, d.width, d.height, innerWidth].map(v => Math.round(v * 100) / 100).join(" ");
};

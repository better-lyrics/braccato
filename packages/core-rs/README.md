# @braccato/core 2

The braccato lyrics renderer rewritten in Rust and drawn with WebGL2. From 2.0, this is
`@braccato/core`, in beta under the npm `beta` tag (`npm i @braccato/core@beta`) while `latest` stays
on 1.x. It shows the same lyrics the same way as the 1.x DOM renderer ([`packages/core`](../core),
kept in this repo as the private `@braccato/core-dom`): the same layout and wrapping, syllable sweep, glow, word
wobble, letter wave, line scale, autoscroll glide, background vocals, timed romanizations,
translations, instrumental note, credits and stage layout. It does all of that from one canvas, so a
playing song costs no style, layout or paint work per frame.

The glow is the one from 1.16.11, restored in PR #112: a single drop shadow of the lit word whose
radius shrinks from `--blyrics-highlight-glow-radius-from` to nothing.

## Use

### As 1.x's renderer

The package's main export has 1.x's renderer interface, so a consumer written against 1.x upgrades
by loading the wasm first:

```js
import { createLyricsRenderer, injectTranslation, load } from "@braccato/core";

await load(); // or load(wasmUrl), or loadSync(bytes); the file is "@braccato/core/wasm"
const view = createLyricsRenderer({ document, window, host: { getScrollElement: () => scroller } });
view.setLyrics(lyrics, { mount, songKey: videoId });
view.tick(player.currentTime, { isPlaying: true, eventCreationTime: Date.now() });
injectTranslation(document, view.lines[3].lyricElement, "…", "en");
view.scheduleLyricPositionUpdate(() => true, () => {});
```

`createLyricsRenderer`, `injectTranslation`, `injectRomanization`, `removeTranslation`,
`removeRomanization`, `resetPlaybackClock` and `resumeAllAutoscroll` take what 1.x's do, and the
leaf modules `@braccato/core/constants`, `/text`, `/themeSettings` and `/util` and the stylesheets
under `@braccato/core/styles/` are 1.x's own. What is different underneath:

- The renderer draws on its own animation frames, so `tick` only hands it the player snapshot (time,
  play state, and when it was read); frames in between carry the time forward. Ticking at 20 ms is
  as smooth as ticking every frame.
- `lines` are records over the Rust song rather than core's render state: `lyricElement`, `parts`,
  and `time` and `duration` in seconds, where writing `time` moves the line or word. The elements are
  the invisible layout DOM's (below), so their `dataset` is the host's to use.
- Decorations are hung on a line with this module's `inject*`, not written into the element, and
  are applied together on the next frame, sliding the lines they move.
- `setTheme` always returns false: the renderer keeps the lyrics and rebuilds them itself.
- Lyrics given with the `songKey` of the song on screen are swapped in: lines the two share keep their
  elements, state and decorations, a changed line is rebuilt in its old element, the line in view
  holds still and the others slide.
- A view can live in another window (Document Picture-in-Picture): it draws on that window's frames
  and resolves fonts against its document.

### As a custom element

```html
<audio id="player" src="song.mp3"></audio>
<braccato-lyrics source="#player"></braccato-lyrics>

<script type="module">
  import { defineLyricsElement, load } from "@braccato/core/element";

  await load();
  defineLyricsElement(); // or defineLyricsElement("my-lyrics")
  document.querySelector("braccato-lyrics").lyrics = lyricsArray;
</script>
```

The element takes the same `Lyric[]` as `@braccato/core` and keeps most of its surface:

| Property        | Notes |
| --------------- | ----- |
| `lyrics`        | `Lyric[]`. Writing it builds the view. |
| `lyricsOptions` | `{ noLyrics?, language?, songwriters? }`, read by the next `lyrics` write. |
| `source`        | A media element or a selector for one. It drives the clock. |
| `currentTime`, `playing` | Drive the clock by hand when there is no `source`. |
| `tickOptions`   | `{ lyricOffset?, globalLyricOffset?, playbackRate?, smoothScroll?, passiveScrollEnabled? }` |
| `theme`         | A stylesheet: `--blyrics-*` custom properties, and `/* blyrics-key = value; */` settings in comments. |
| `host`          | `{ getScrollElement? }`, the element autoscroll moves. |
| `layout`        | `"scroll"` or `"stage"`. Also an attribute. |
| `decorations`   | `{ translations, romanizations }`: whether to show the lyrics' own `translations` and `romanization` / `timedRomanization`. Both on by default. |
| `renderer`      | The Rust `Renderer`, which has `resumeAutoscroll()`, `relayout()`, `setProfiling(on)`, `stats()` and `takeProfile()`. |

It dispatches the same events: `braccato:lyrics-loaded`, `braccato:line-click`,
`braccato:scroll-state`, `braccato:stage-layout` and `braccato:error`.

Anything the host puts in the container stays ordinary, visible DOM (a footer, buttons), and so does
anything it puts in the credits (a source card), which moves with the credits on the stage. The
lines' text is transparent rather than hidden, so it can be selected and copied.

## Theming

Themes are not compatible with `@braccato/core` themes, because there are no lines in the DOM to
style. What carries over is everything a theme says through custom properties: colours, fonts and
sizes, padding, line height, letter spacing, swipe stops, glow radius and timing, wobble and
letter-wave transforms, scale, fade and scroll timing, credits, and the `--blyrics-animate-*` switches.
The comment settings work as before, including `blyrics-image-highlights = true;`, which fills the
instrumental note with `--blyrics-highlight-image`. Selectors still scope these properties, so a rule like
`.blyrics-word-highlight:not([data-long-word]) { --blyrics-glow-color: transparent; }` still makes only
held words glow.

Rules that style the lines directly (filters, per-line opacity, `display: none`, keyframes) have no
effect. Blurring and fading lines by how far they are from the one being sung, which themes like
Sustain do with chains of sibling selectors, is instead two lists:

```css
.blyrics-container {
  /* opacity and blur for the sung line, then 1, 2, 3… lines away */
  --blyrics-line-opacity-after: 1 0.88 0.72 0.52 0.28 0;
  --blyrics-line-blur-after: 0 1.125px 2.5px 4.125px 6px;
}
```

`--blyrics-line-opacity` and `--blyrics-line-blur` apply to both sides, and `-before` / `-after`
replace one side: lines already sung, or still to come. Values between whole lines are interpolated,
the last value holds past the end, and blurs are the standard deviation, as CSS `blur()` takes it.
The distance follows the scroll smoothly, and the effects ease off while the reader scrolls.

The line under the mouse can look different, as a `:hover` rule made it in the DOM renderer. Each
value the theme sets replaces the line's own while the pointer is on it, and leaving it unset keeps
the line as it is:

```css
.blyrics-container {
  --blyrics-line-hover-opacity: 1;   /* over the distance opacity */
  --blyrics-line-hover-blur: 0;      /* over the distance blur; px, rem or blur(…) */
  --blyrics-line-hover-scale: 1.04;  /* over --blyrics-scale / --blyrics-active-scale */
  --blyrics-line-hover-color: white; /* the words' inactive colour; the sung part keeps its own */
  --blyrics-line-hover-duration: 0.2s;
  --blyrics-line-hover-easing: ease;
}
```

Touch has no hover, so a tap never leaves a line looking hovered.

A few more properties stand in for rules that styled lines and words by state:

```css
.blyrics-container {
  /* other lines while the pointer is over the lyrics or a reader scrolls */
  --blyrics-line-opacity-browsing: 0.5;
  /* distance lists like the opacity ones, applied to the line's colours */
  --blyrics-line-saturate-after: 1 0.9 0.8;
  --blyrics-line-brightness-before: 1 0.8;
}

.blyrics--word {
  /* a sung word, while its line is still being sung */
  --blyrics-word-past-opacity: 0.6;
  /* word-synced words wait here until sung, then rise out of it over their duration */
  --blyrics-word-rest-transform: translateY(3px);
  --blyrics-word-rise-extra-duration: 0.2s;
  --blyrics-word-rise-easing: ease;
}

.blyrics--line, .blyrics--translated {
  /* text-shadow's syntax; drawn once with the line, the same in every state */
  --blyrics-text-shadow: 0 0.3rem 0.5rem rgb(0 0 0 / 0.15);
}
```

The shadow, the past opacity and the rest pose are read from each element, so selectors scope them
as they do colours. The browsing opacity and the distance lists are read from the container.

Instrumental lines and the no-lyrics message, which themes restyled with `::before` and `::after`,
take these instead:

```css
.blyrics-container {
  /* note (the default), dots (lit one after another in reading order), or text such as "♫" */
  --blyrics-instrumental-icon: dots;
  /* swells to this scale and back once a period while the instrumental plays */
  --blyrics-instrumental-pulse-scale: 1.14;
  --blyrics-instrumental-pulse-duration: 3s;
  /* in place of the host's message when there are no lyrics, and text drawn above it */
  --blyrics-no-lyrics-text: "No lyrics found";
  --blyrics-no-lyrics-icon: "♫";
}

/* the no-lyrics icon is an element of its own, 4em by default */
.blyrics-no-lyrics-icon { font-size: 6rem; }
```

The wobble and the letter wave have a few more controls. A held word is one sung for longer than
`blyrics-long-word-threshold`, and with `blyrics-long-word-max-letters = 8;` one of at most 8
letters, so a long word like "everybody" is not one however long it is held.
`blyrics-letter-wave = long;` waves only held words; the rest move as one piece.

```css
.blyrics-container {
  /* held words: the outermost letters move this far out at their crest, the rest in proportion */
  --blyrics-letter-wave-spread: 0.04em;
  /* held words that glow: each letter's glow up to 1 + this as bright at its crest */
  --blyrics-letter-wave-glow: 0.8;
  /* word (the default) or syllable: each syllable wobbles on its own, about its own centre */
  --blyrics-word-wobble-scope: syllable;
  /* the wobble lasts --blyrics-wobble-duration plus this many times the syllable's duration */
  --blyrics-word-wobble-duration-ratio: 0.5;
  /* any easing can be a linear() curve, such as a spring */
  --blyrics-word-wobble-easing: linear(0, 0.6 20%, 1.08 40%, 0.98 65%, 1);
}

.blyrics--romanized {
  /* the box behind romanization; transparent for none */
  --blyrics-romanized-bg-color: transparent;
  /* the box's padding and border-radius are the theme's own, as in the DOM renderer */
  padding: 0;
}
```

The glow peak brightens a glow up to its colour fully opaque, so it shows on a translucent glow
colour such as the default. A word's text-shadow moves with the word, but not with each letter's
wave.

## How it works

The lines are laid out by the browser in an invisible copy of `@braccato/core`'s markup, inside the
element. That gives the same wrapping, bidi reordering and font fallback, and it stays in the page
for scrolling, clicks and screen readers. It is measured once per layout.

Each line is then drawn once with the browser's own text engine (Canvas 2D), as coverage the shader
tints, and copied into the line pages: one array texture with mipmaps, each layer packed with lines
on shelves.

Every frame, Rust works out each visible line's state from the lyric clock: its scale, how far the
sweep has got, the glow's radius, the wobble and the letter wave. It writes one quad per letter or
word, placed on its line's spot in the pages, and draws them all with one instanced call. The
fragment shader mixes the inactive and lit colours across the sweep's edge.

Glows, the instrumental note's glow and blurred lines are real Gaussian blurs of what is lit (the
letters behind the sweep, the filled part of the note), made on the GPU each frame. What is to be
blurred is drawn with the same quads into an atlas, scaled down so its standard deviation spans 1.5
to 3 texels and reading the matching mip level, blurred across and then down with an instanced pass
each, and drawn back onto the canvas as one quad among the rest. Six glowing words cost about 0.1 ms
of GPU time. However many lines are on screen, a frame is four draws at most: the blur jobs, the two
blur passes, and the canvas.

The shader is written in WGSL. `build.rs` parses and validates it with naga, a build-dependency
only, and writes GLSL ES 3.00 for WebGL2, so a shader mistake fails `cargo build` with naga's report
rather than showing up as a compile log in the browser. naga renames the uniform buffer and the
textures, and the build script writes those names out as Rust constants for `gpu.rs` to bind by.
The two quad draws each have an instance buffer whose attributes are set up once, so a frame only
uploads quads and draws. Texture sizes come from `textureDimensions` in the shader, and the one
uniform buffer is written when the canvas resizes.

| File | What it holds |
| ---- | ------------- |
| `src/model.rs` | The `Lyric` input shapes |
| `src/song.rs` | Lyrics into lines, rows, word groups and timed parts (core's rules) |
| `src/layout.rs`, `src/style.rs` | The hidden DOM and its measurement into drawable slots |
| `src/raster.rs` | Drawing a line's slots onto a canvas, for the line pages |
| `src/paint.rs` | What every line looks like at a given moment, as quads |
| `src/scroll.rs` | Autoscroll targets and the per-line glide |
| `src/stage.rs` | The stage layout's roles and motion |
| `src/clock.rs` | Smoothing the media clock between reports |
| `src/shaders/*.wgsl` | The quad and blur shaders, in WGSL |
| `build.rs` | Validates the WGSL with naga and writes GLSL ES 3.00 and its resource names at build time |
| `src/gpu.rs` | WebGL2: the programs, instance buffers, the line pages and their allocator, the blur atlas |
| `src/renderer.rs` | The view: state, a frame, events |
| `src/profile.rs` | Per-frame timings by phase, for `takeProfile()` and `pnpm bench` |
| `src/lib.rs` | The `Renderer` exported to JavaScript, and its event wiring |
| `js/element.js` | The custom element |

## Cost

Measured with `pnpm bench` on an Intel Arc iGPU (Meteor Lake) in Chrome: a 1632 × 1000 canvas at
device pixel ratio 1.33, 240 Hz, the song playing. Medians of three 15 s runs:

| Demo song | Renderer CPU per frame, mean / p99 | GPU per frame |
| --------- | ---------------------------------- | ------------- |
| Kettle | 0.063 / 0.125 ms | 0.13 ms |
| Kettle, Sustain theme (lines blurred by distance) | 0.075 / 0.140 ms | 0.41 ms |
| The Steps (long glowing words) | 0.065 / 0.145 ms | 0.18 ms |
| Kettle, stage layout | 0.049 / 0.100 ms | 0.07 ms |

At 240 Hz that is about 1.5% of a core and 3 to 10% of the GPU. A line costs about 1 ms more on the
frame it is rasterized, as it scrolls into view. In Better Lyrics on YouTube Music, counting the whole
page with the video playing, the main thread was 13 to 14% busy against 40 to 45% for
`@braccato/core` 1.21.6, Chrome's renderer process used 32 to 34% of a core against 70 to 77%, and
its GPU process 38 to 39% against 51%.

### Benchmarks and profiles

`pnpm bench` (`tooling/bench.ts`) plays demo songs on the compare page in a real Chrome, one
renderer at a time, and reports for each scenario the median and range over several runs:

- each frame's CPU time in the renderer, as percentiles and split by phase (preparing, updating
  clock and scroll, rasterizing, painting quads, moving riders, submitting to the GPU), and its GPU
  time;
- the page's main thread (busy, script, layout, style) and Chrome's renderer and GPU processes, in
  milliseconds per second, which compare this renderer with `@braccato/core` (`--renderers rs,dom`).

`--save before.json`, then `--baseline before.json` after a change, prints each number's change and
marks the ones within the runs' noise. `--profile` adds a run per scenario under Chrome's sampling
profiler, writes a `.cpuprofile` for DevTools' Performance panel to `.bench/`, and prints the
functions with the most time; build with `pnpm -C packages/core-rs build:profiling` first so Rust
functions have names. `pnpm bench --help` lists the options.

The numbers come from `renderer.setProfiling(true)`, after which `renderer.takeProfile()` returns
every frame's phase times and `renderer.stats()` running averages.

## Build and test

Needs a Rust toolchain with the `wasm32-unknown-unknown` target, clippy and rustfmt, and `wasm-pack`.
Without them every step prints a notice and skips, so `pnpm build`, `pnpm lint` and `pnpm test` still
pass for the rest of the workspace. CI and the release workflow install them and set
`BRACCATO_REQUIRE_RUST`, which makes a missing toolchain fail instead, so the package is never
published without its wasm.

The wasm is built with WebAssembly SIMD (`.cargo/config.toml`), which Chrome 91, Firefox 89 and
Safari 16.4 run.

```bash
pnpm -C packages/core-rs build             # wasm-pack into pkg/
pnpm -C packages/core-rs build:profiling   # the same, with function names for CPU profiles
pnpm -C packages/core-rs lint              # cargo fmt --check, clippy with warnings as errors
pnpm -C packages/core-rs test              # cargo test: song building, timing, scroll, stage, clock, easing, line pages
```

`demo/compare.html`, on the dev server only (`pnpm -C demo dev`), puts this renderer next to
`@braccato/core` on one clock. Its URL holds the
whole state (`?song=kettle&t=10.6&layout=stage&mode=split`), so a moment can be screenshotted
again and compared.

## Differences from `@braccato/core`

- Theme rules that style line elements directly have no effect, as above.
- Image highlights are drawn into the canvas, which is standard dynamic range: an HDR image shows
  its SDR rendition.
- On Firefox, core centres the sung line about 3% of the view higher than it does on Chrome (its
  line measurement differs there); this renderer centres it as core does on Chrome, in both.
- Checked in Chrome and Firefox; Safari has not been screenshotted.

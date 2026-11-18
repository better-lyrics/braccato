# @braccato/core-rs

The braccato lyrics renderer rewritten in Rust and drawn with WebGL2. It shows the same lyrics the
same way as [`@braccato/core`](../core): the same layout and wrapping, syllable sweep, glow, word
wobble, letter wave, line scale, autoscroll glide, background vocals, timed romanizations,
translations, instrumental note, credits and stage layout. It does all of that from one canvas, so a
playing song costs no style, layout or paint work per frame.

The glow is the one from 1.16.11, restored in PR #112: a single drop shadow of the lit word whose
radius shrinks from `--blyrics-highlight-glow-radius-from` to nothing.

## Use

### As `@braccato/core`'s renderer

The package's main export has `@braccato/core`'s renderer interface, so a consumer written against
core switches by changing where it imports from and loading the wasm first:

```js
import { createLyricsRenderer, injectTranslation, load } from "@braccato/core-rs";

await load(); // or load(wasmUrl), or loadSync(bytes); the file is "@braccato/core-rs/wasm"
const view = createLyricsRenderer({ document, window, host: { getScrollElement: () => scroller } });
view.setLyrics(lyrics, { mount, songKey: videoId });
view.tick(player.currentTime, { isPlaying: true, eventCreationTime: Date.now() });
injectTranslation(document, view.lines[3].lyricElement, "…", "en");
view.scheduleLyricPositionUpdate(() => true, () => {});
```

`createLyricsRenderer`, `injectTranslation`, `injectRomanization`, `removeTranslation`,
`removeRomanization`, `resetPlaybackClock` and `resumeAllAutoscroll` take what core's do. What is
different underneath:

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
  import { defineLyricsElement, load } from "@braccato/core-rs/element";

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
| `renderer`      | The Rust `Renderer`, which has `resumeAutoscroll()`, `relayout()`, `setProfiling(on)` and `stats()`. |

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

## How it works

The lines are laid out by the browser in an invisible copy of `@braccato/core`'s markup, inside the
element. That gives the same wrapping, bidi reordering and font fallback, and it stays in the page
for scrolling, clicks and screen readers. It is measured once per layout.

Each line is then drawn once into a texture with the browser's own text engine (Canvas 2D), as
coverage the shader tints, with mipmaps.

Every frame, Rust works out each visible line's state from the lyric clock: its scale, how far the
sweep has got, the glow's radius, the wobble and the letter wave. It writes one quad per letter or
word and draws each line with one instanced call. The fragment shader mixes the inactive and lit
colours across the sweep's edge.

Glows, the instrumental note's glow and blurred lines are real Gaussian blurs of what is lit (the
letters behind the sweep, the filled part of the note), made on the GPU each frame. What is to be
blurred is drawn with the same quads into an atlas, scaled down so its standard deviation spans 1.5
to 3 texels and reading the matching mip level, blurred across and then down with an instanced pass
each, and drawn back onto the canvas as one quad. Six glowing words cost about 0.1 ms of GPU time.

The shader is written in WGSL. `build.rs` parses and validates it with naga, a build-dependency
only, and writes GLSL ES 3.00 for WebGL2, so a shader mistake fails `cargo build` with naga's report
rather than showing up as a compile log in the browser. naga renames the uniform buffer and the
texture, and the build script writes those names out as Rust constants for `gpu.rs` to bind by.
Between draws only the bound texture and the instance range change: the texture's size comes from
`textureDimensions` in the shader, and the one uniform buffer is written when the canvas resizes.

| File | What it holds |
| ---- | ------------- |
| `src/model.rs` | The `Lyric` input shapes |
| `src/song.rs` | Lyrics into lines, rows, word groups and timed parts (core's rules) |
| `src/layout.rs`, `src/style.rs` | The hidden DOM and its measurement into drawable slots |
| `src/raster.rs` | Drawing a line's slots into its texture |
| `src/paint.rs` | What every line looks like at a given moment, as quads |
| `src/scroll.rs` | Autoscroll targets and the per-line glide |
| `src/stage.rs` | The stage layout's roles and motion |
| `src/clock.rs` | Smoothing the media clock between reports |
| `src/shaders/*.wgsl` | The quad and blur shaders, in WGSL |
| `build.rs` | Validates the WGSL with naga and writes GLSL ES 3.00 and its resource names at build time |
| `src/gpu.rs` | WebGL2: the program, the instance buffer, the uniform buffer, line textures |
| `src/renderer.rs` | The view: state, a frame, events |
| `src/lib.rs` | The `Renderer` exported to JavaScript, and its event wiring |
| `js/element.js` | The custom element |

## Cost

Measured on an Intel Arc iGPU (Meteor Lake), Chrome, a 2092 × 1208 canvas at device pixel ratio 1.33,
the fastest demo song playing:

- 0.13 to 0.34 ms of CPU per frame in the renderer, 1 ms at worst while new lines are rasterized.
- 0.19 ms of GPU time per frame: about 1% of the GPU at 60 fps and 5% at 240 Hz.
- Main thread busy 7% against 37% for `@braccato/core` over the same playback, and the compositor
  thread 3% against 13%.

With six words glowing, the GPU blur adds about 0.1 to 0.18 ms. `renderer.setProfiling(true)` and
`renderer.stats()` report the per-frame numbers.

## Build and test

Needs a Rust toolchain with the `wasm32-unknown-unknown` target and `wasm-pack`. Without them both
steps print a notice and skip, so `pnpm build` and `pnpm test` still pass for the rest of the
workspace. The release workflow installs both and sets `BRACCATO_REQUIRE_RUST`, which makes a missing
toolchain fail the build instead, so the package is never published without its wasm.

```bash
pnpm -C packages/core-rs build   # wasm-pack into pkg/
pnpm -C packages/core-rs test    # cargo test: song building, timing, scroll, stage, clock, easing
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

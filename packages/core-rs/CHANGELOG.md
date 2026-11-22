# @braccato/core

## 2.0.0-beta.3

### Patch Changes

- 08fd796: Clicking a line while the lyrics glide to their next position seeks to the line shown under the mouse, rather than to the one that will be there when the glide ends. Alt-click picks the word shown there too.

## 2.0.0-beta.2

### Patch Changes

- 3aabe43: Autoscroll now pauses on a reader's first scroll, and says so, where it could miss it: when the host's scroll listener runs before the renderer's (as it does for a page's first song, and on every scroll of drifting unsynced lyrics there), and after the lyrics were laid out while playback was paused. The scroll state is also reported on every scroll again, as in 1.x, so a resume button the host hid during the pause comes back.

## 2.0.0-beta.1

### Minor Changes

- 8c9fbc8: Themes can give the line under the mouse its own look, as `:hover` rules did with the DOM renderer: `--blyrics-line-hover-opacity`, `--blyrics-line-hover-blur` and `--blyrics-line-hover-scale` replace the line's distance opacity, distance blur and scale while the pointer is on it, eased over `--blyrics-line-hover-duration` (0.2s) with `--blyrics-line-hover-easing` (`ease`). A value the theme leaves unset keeps the line as it is, so existing themes look the same. Touch input does not hover.

## 2.0.0-beta.0

### Major Changes

- b266b6e: `@braccato/core` 2.0 renders lyrics with the braccato renderer rewritten in Rust and drawn with WebGL2, in place of the DOM renderer. It shows lyrics the way 1.x does (the same wrapping, sweep, glow, wobble, letter wave, scroll glide, decorations, instrumental note, credits and stage layout) from one canvas, so a playing song costs a fraction of a millisecond of main-thread time per frame.
  
  The renderer keeps 1.x's interface: `createLyricsRenderer`, `injectTranslation`, `injectRomanization`, `removeTranslation`, `removeRomanization`, `resetPlaybackClock` and `resumeAllAutoscroll` take the same arguments, and `@braccato/core/constants`, `/text`, `/themeSettings`, `/util` and the stylesheets under `@braccato/core/styles/` are 1.x's. What breaks:
  
  - Call `load()` (or `loadSync()` with the wasm's bytes) before creating a renderer. The wasm is exported as `@braccato/core/wasm`.
  - It needs WebGL2: `setLyrics` throws where the browser has none, for example with hardware acceleration turned off.
  - Themes carry over through their `--blyrics-*` custom properties and comment settings; rules that style line elements directly have no effect, because the lines are drawn on a canvas.
  - `lines` are records over the renderer's song (`lyricElement`, `parts`, `time`, `duration`) rather than the DOM renderer's state.
  - The `<braccato-lyrics>` element from `@braccato/core/element` is the Rust renderer's, which takes the same lyrics and most of 1.x's attributes; its README lists the differences.

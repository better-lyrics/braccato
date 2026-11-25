# @braccato/core

## 2.0.0-beta.8

### Patch Changes

- 5df8da5: The scroll position is read with its fraction. Chrome keeps scroll positions on whole device pixels, so at a device pixel ratio of 1.25 or 1.5 the scroller sits at positions such as 100.8 px. The renderer read those as whole numbers, so its lines and the page's layout could disagree by up to 0.8 px. A glide planned while the canvas moved with the page could then start with a small jump.

## 2.0.0-beta.7

### Patch Changes

- 30d35e2: Scrolls start smoothly again:
  
  - A line that comes within a screen of the view as a scroll starts is no longer drawn on that same frame, which could take 8 to 15 ms and drop frames just as the lines began to glide. Drawing a line is also much quicker, because its canvas is now kept in memory, where Chrome copies it to the GPU in well under a millisecond.
  - The sung line no longer rises by a pixel just before the others start to move. Lines at rest still sit on whole device pixels, but each glide now starts exactly where its line was drawn and ends on a whole pixel. A line is no longer pulled to the nearest pixel while it moves.

## 2.0.0-beta.6

### Minor Changes

- 412b059: Themes can draw boxes behind lines and change text shadows with a line's state:
  
  - `--blyrics-line-bg-color` fills a box behind a line, and `--blyrics-line-border-color` with `--blyrics-line-border-width` (1px) draws a border inside its edge. The box covers the line's whole box, padding included, with the line's own `border-radius`, where the DOM renderer painted a line's `background`. It is set per line, so a selector such as `[data-layout="stage"] > .blyrics--line` scopes it. `--blyrics-line-hover-bg-color` and `--blyrics-line-hover-border-color` are what the hovered line's box eases to, alongside the other hover properties.
  - `--blyrics-active-text-shadow` is the text shadow while a line is being sung, easing in and out with the line's scale transition, and `--blyrics-line-hover-text-shadow` the one while it is hovered. Like `--blyrics-text-shadow`, each is drawn once with the line, and changing between them only fades one into the other.
  - `linear()` easings continue their first and last segments before the first stop and after the last, as CSS does, instead of holding there. Hover, the line's exit and the distance effects' focus settle on their end once done, whatever the curve's last value; the line's entrance holds it, as the DOM renderer's did.
  - A colour property set to something that is not a colour now counts as unset instead of transparent.

## 2.0.0-beta.5

### Minor Changes

- ab73777: Themes get more ways to say what `:hover`, `filter`, `text-shadow`, `::before`/`::after` and per-word state rules said in the DOM renderer, so more of the theme store carries over:
  
  - `--blyrics-word-past-opacity` fades a word once it has been sung, while its line is still being sung, over the highlight's fade-out. Opacity Based Karaoke and similar themes dim sung words this way.
  - `--blyrics-line-opacity-browsing` is the opacity every line other than the sung and hovered ones eases to while the pointer is over the lyrics or a reader scrolls, over the hover's duration.
  - `--blyrics-word-rest-transform` is a pose (translations and scales) that word-synced words wait in until the sung line reaches them, then rise out of over their own duration plus `--blyrics-word-rise-extra-duration` (0.2s) with `--blyrics-word-rise-easing` (`ease`). This is the Apple Music lift.
  - `--blyrics-line-saturate` and `--blyrics-line-brightness`, with `-before` and `-after`, are distance lists like the opacity and blur ones, applied to the line's colours.
  - `--blyrics-instrumental-icon` picks what instrumental lines show: `note` (the default), `dots` (Apple Music's three dots, lit one after another in reading order over the instrumental), or a string such as `"♫"`, which fills from the bottom and glows like the note. `--blyrics-instrumental-pulse-scale` and `--blyrics-instrumental-pulse-duration` (1.5s) make it swell and settle once a period while the instrumental plays.
  - `--blyrics-no-lyrics-text` replaces the host's message when there are no lyrics, and `--blyrics-no-lyrics-icon` draws a string above it in a `.blyrics-no-lyrics-icon` element, 4em by default, which the theme can size.
  - `--blyrics-line-hover-color` is the inactive colour the hovered line's words ease to, alongside the other hover properties.
  - `blyrics-letter-wave = long;` waves only held words, and `blyrics-long-word-max-letters = 8;` keeps words longer than 8 letters from counting as held. On held words, `--blyrics-letter-wave-spread` moves letters out from the word's centre at their crest, and `--blyrics-letter-wave-glow` brightens each letter's glow as its crest passes.
  - `--blyrics-word-wobble-scope: syllable` wobbles each syllable on its own, and `--blyrics-word-wobble-duration-ratio` lengthens the wobble by a share of the syllable's duration.
  - Every easing property accepts CSS `linear()`, so spring curves can be written directly. It used to fall back to `ease`.
  - `--blyrics-romanized-bg-color` sets the box behind romanization; `transparent` draws none. A theme's own `padding` and `border-radius` on `.blyrics--romanized` now apply whatever their selector, as they did in the DOM renderer, so plain-text romanization sits flush with the line.
  - `--blyrics-text-shadow` takes `text-shadow`'s syntax on lines, words, translations and romanizations. It is drawn once into the line's texture under its text, so it costs nothing per frame, and it is static: the same whether the line is sung or hovered.
  
  A theme that sets none of them looks the same as before, with two exceptions. A `::before` or `::after` on an instrumental or no-lyrics line no longer takes up room it was never drawn in. And when a theme hides the host's no-lyrics message to show its own in a pseudo-element, which this renderer does not draw, the host's message now shows instead of nothing; `--blyrics-no-lyrics-text` puts the theme's own there.

## 2.0.0-beta.4

### Patch Changes

- a4ace62: A new song starts at its top. Before, it could scroll down and glide back when it came up: it took on the previous song's time, which `resetPlaybackClock()` and a stop at zero between songs no longer carry over, and it measured its lines where a page's slide-in transform had put them for a moment. A song put up while the view was scrolled elsewhere is now scrolled to its start at once, instead of gliding there when it plays, and unsynced lyrics drift from their top again.

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

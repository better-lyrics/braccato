---
"@braccato/core": minor
---

Themes get more ways to say what `:hover`, `filter`, `text-shadow`, `::before`/`::after` and per-word state rules said in the DOM renderer, so more of the theme store carries over:

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

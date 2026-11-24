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
- `--blyrics-text-shadow` takes `text-shadow`'s syntax on lines, words, translations and romanizations. It is drawn once into the line's texture under its text, so it costs nothing per frame, and it is static: the same whether the line is sung or hovered.

A theme that sets none of them looks the same as before.

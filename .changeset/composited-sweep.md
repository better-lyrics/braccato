---
"@braccato/core": minor
---

The karaoke sweep, its glow and the letter wave run off the main thread, so they keep moving while the page is busy and no longer repaint every active word on every frame. Each word, or each letter of a word that wraps, holds a fixed soft-edged mask over a copy of its text, and the two slide against each other; a word in a joining script or one mixing directions is drawn from copies of its line placed over each box it breaks into. The glow is two fixed halos inside the same mask, crossfaded from wide to tight, instead of a shrinking `drop-shadow`.

The old sweep is removed rather than kept as a fallback: `--lyric-transition-amount-*` and their `@property` registrations are gone, so a theme that draws its own sweep from them stops moving; the `--blyrics-highlight-glow-filter-*` overrides no longer change the glow; and image fills on words are gone, so `blyrics-image-highlights` now paints only the instrumental note and `--blyrics-image-glow-opacity-*` do nothing.

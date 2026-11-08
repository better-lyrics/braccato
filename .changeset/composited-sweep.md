---
"@braccato/core": minor
---

The karaoke sweep, its glow and the letter wave run off the main thread, so they keep moving while the page is busy and no longer repaint every active word on every frame. Each word, or each letter of a word that wraps, holds a fixed soft-edged mask over a copy of its text, and the two slide against each other; a word in a joining script or one mixing directions is drawn from copies of its line placed over each box it breaks into. The glow is two fixed halos crossfaded from wide to tight instead of a shrinking `drop-shadow`, so the `--blyrics-highlight-glow-filter-*` overrides are no longer read. `--lyric-transition-amount-*` no longer animate, so a theme that draws its own sweep from them stops moving, and image highlights (`blyrics-image-highlights`) currently build no layers.

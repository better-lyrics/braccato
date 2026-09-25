# @braccato/core

## 1.12.2

### Patch Changes

- c4af4ed: Keep theme rules written for the lines off the songwriter credits. The credits were a `div`, so `.blyrics-container > div` rules such as hover scaling and per-line opacity reached them too; they are a `p` now and carry their own inset and scale.

## 1.12.1

### Patch Changes

- 5a8b71c: Line the songwriter credits up with the lyrics. The credits took their smaller size on the element the lines' `0.25em` inset applies to, so they sat a few pixels further out than the text above them; the size now lives on an inner `.blyrics-credits__text` block.

## 1.12.0

### Minor Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.

## 1.11.0

### Minor Changes

- 7e68c83: Explicit words are no longer struck through by default. The `blyrics-explicit` class is still set, so a theme that wants the strikethrough can add `.blyrics-explicit { text-decoration: line-through; }`.

## 1.10.0

### Minor Changes

- 630f8a2: Read the target scroll position from `--blyrics-target-scroll-pos-ratio` on the lyrics container when it resolves, so a theme can scope it to one view with a selector.

## 1.9.0

### Minor Changes

- ece674c: Remove the synced autoscroll cooldown and queue. New lyric groups scroll immediately while existing additive line animations continue. Lines included by lookahead are remembered when a scroll commits and do not trigger another scroll at their own start; entering the lookahead window alone never triggers a scroll. Seeking and resuming autoscroll still retarget the viewport.
  
  Give `blyrics-early-scroll-consider-s` an independent default of 0.54 seconds. `blyrics-queue-scroll-ms` is no longer used. Remove `--blyrics-lyric-scroll-duration`, its `--blyrics-lyric-transition-duration` alias and the obsolete container transform transition. Set visual duration with the line-scroll duration knobs; invalid or nonpositive durations use an internal 750ms fallback. Themes that explicitly reference the removed variables must replace those references with a duration or their own custom property.

## 1.8.0

### Minor Changes

- a6fa236: Tag original lyrics, translations, and romanizations with their language so CJK glyph selection does not inherit the host UI language. Add a source language option, live language updates, and an optional translation language argument. Resolve default font fallbacks at each language boundary while retaining theme font overrides.

## 1.7.1

### Patch Changes

- b511064: Fix timed romanization highlights collapsing to zero width and wrapping over subsequent lines in Firefox by keeping their positioned container block-level.

## 1.7.0

### Minor Changes

- 1403580: Add a per-word `data-word-state` attribute (`upcoming`, `active`, `past`) written on every word, so a theme can style words by whether they are being sung, already sung, or not yet reached.
  
  Fix romanization landing below a translation when the translation arrives first. Romanization now always sits above the translation, regardless of which one is injected first.

### Patch Changes

- 5b5d3f5: Split the Letter Wave animation on grapheme clusters instead of code points, so Devanagari, Bengali and other Indic scripts (and emoji sequences) keep each visual letter whole instead of breaking a consonant apart from its vowel signs.

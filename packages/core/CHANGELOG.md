# @braccato/core

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

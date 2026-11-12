# @braccato/parsers

## 0.4.3

### Patch Changes

- 5ef68a7: Describe paired-timestamp LRC by its format instead of a vendor name, and drop the outdated `musixmatch` package keyword.

## 0.4.2

### Patch Changes

- d12c6dd: Long songs play with less work per frame: off-screen lines are skipped from the positions relayout measured instead of an IntersectionObserver over every line, line animation checks stop building an array per line, and `TTMLParser.metadata` reuses the parse `TTMLParser.parse` just did on the same document.

## 0.4.1

### Patch Changes

- ac28099: Number each background vocal group of a TTML line with a new `backgroundGroup` on its parts, read timing written on an `x-bg` span itself in a word-timed line, and give each group its own background row.
- Updated dependencies [ac28099]
  - @braccato/types@1.1.0

## 0.4.0

### Minor Changes

- cc6bc80: LRC and enhanced LRC now get instrumental lines on the same terms as TTML. Blank and music-note lines no longer render as empty rows: they end the line before them, and a silence longer than `instrumentalGapMs` (now an option on `parseLRC`) becomes an instrumental, including the intro and the outro. A closing word timestamp in enhanced LRC ends the line there instead of opening an empty part.

## 0.3.2

### Patch Changes

- 8ddaae2: Add @braccato/highlight, and expose format detection as @braccato/parsers/format

## 0.3.1

### Patch Changes

- f86c97f: LRC reads songwriters from timed credit lines such as `作词：` or `Written by:`, in plain and enhanced LRC, and keeps credit lines out of the parsed lyrics the way QRC does. Both parsers now recognise Traditional Chinese roles and joined or tagged roles such as `作曲/编曲`, `作詞・作曲` and `Rap作词`, and no longer take a sung line ending in a role noun for a credit.

## 0.3.0

### Minor Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.

## 0.2.3

### Patch Changes

- d87ef23: Keep the parentheses around LySy background vocals instead of dropping them, so background text renders the way the source wrote it.

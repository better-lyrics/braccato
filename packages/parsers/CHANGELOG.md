# @braccato/parsers

## 0.3.0

### Minor Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.

## 0.2.3

### Patch Changes

- d87ef23: Keep the parentheses around LySy background vocals instead of dropping them, so background text renders the way the source wrote it.

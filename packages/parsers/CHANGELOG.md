# @braccato/parsers

## 0.3.1

### Patch Changes

- f86c97f: LRC reads songwriters from timed credit lines such as `作词：` or `Written by:`, in plain and enhanced LRC, and keeps credit lines out of the parsed lyrics the way QRC does. Both parsers now recognise Traditional Chinese roles and joined or tagged roles such as `作曲/编曲`, `作詞・作曲` and `Rap作词`, and no longer take a sung line ending in a role noun for a credit.

## 0.3.0

### Minor Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.

## 0.2.3

### Patch Changes

- d87ef23: Keep the parentheses around LySy background vocals instead of dropping them, so background text renders the way the source wrote it.

# @braccato/provider-blyrics

## 0.2.2

### Patch Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.
- Updated dependencies [6dd3dc7]
  - @braccato/parsers@0.3.0

# @braccato/provider-blyrics

## 0.2.4

### Patch Changes

- 5ef68a7: Describe paired-timestamp LRC by its format instead of a vendor name, and drop the outdated `musixmatch` package keyword.
- Updated dependencies [5ef68a7]
  - @braccato/parsers@0.4.3

## 0.2.3

### Patch Changes

- Updated dependencies [cc6bc80]
  - @braccato/parsers@0.4.0

## 0.2.2

### Patch Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.
- Updated dependencies [6dd3dc7]
  - @braccato/parsers@0.3.0

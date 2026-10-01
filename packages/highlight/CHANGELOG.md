# @braccato/highlight

## 0.2.0

### Minor Changes

- 9289f80: `tokenize` now returns the tokens the built-in renderers draw: adjacent tokens of the same type are joined into one, so a renderer of your own reproduces `highlightInto` exactly with no merging step. Code that relied on the finer split (for example a separate `text` token for each newline, or `]` and `[` as two `punct` tokens) sees fewer, longer tokens. The editor handle gains `setFormat(format?)`, which changes the format of a live editor without re-attaching, so the textarea keeps its undo history. The editor now copies its options at attach time; later writes to the options object are ignored.

## 0.1.2

### Patch Changes

- 7b7ec4b: Make the editor overlay fast on very long lines, such as minified TTML stored on one line. A keystroke now rewrites only the text nodes whose tokens changed instead of rebuilding the whole line, and the input handler no longer forces a synchronous layout. Only the text near the visible part of the editor is coloured; the rest renders as plain text in the same font, so alignment is unchanged. A keystroke in a 21.4k-character one-line TTML drops from about 10 ms to under 3 ms, and in a 98k-character one from about 49 ms to under 7 ms.

## 0.1.1

### Patch Changes

- e566499: Make the editor overlay fast enough for live typing on large syllable-timed TTML. Adjacent tokens of the same type now render as one node, and each input rebuilds only the lines whose tokens changed, with every line laid out as its own block. A keystroke in a 320-line TTML with background vocals drops from about 100 ms to a few milliseconds.
  
  The editor textarea is now forced to `box-sizing: border-box`, so a textarea with padding or borders no longer overflows the wrapper and drifts off the highlighted text.

## 0.1.0

### Minor Changes

- 8ddaae2: Add @braccato/highlight, and expose format detection as @braccato/parsers/format

### Patch Changes

- Updated dependencies [8ddaae2]
  - @braccato/parsers@0.3.2

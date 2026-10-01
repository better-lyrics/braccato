---
"@braccato/highlight": minor
---

`tokenize` now returns the tokens the built-in renderers draw: adjacent tokens of the same type are joined into one, so a renderer of your own reproduces `highlightInto` exactly with no merging step. Code that relied on the finer split (for example a separate `text` token for each newline, or `]` and `[` as two `punct` tokens) sees fewer, longer tokens. The editor handle gains `setFormat(format?)`, which changes the format of a live editor without re-attaching, so the textarea keeps its undo history. The editor now copies its options at attach time; later writes to the options object are ignored.

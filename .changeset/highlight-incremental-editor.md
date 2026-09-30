---
"@braccato/highlight": patch
---

Make the editor overlay fast enough for live typing on large syllable-timed TTML. Adjacent tokens of the same type now render as one node, and each input rebuilds only the lines whose tokens changed, with every line laid out as its own block. A keystroke in a 320-line TTML with background vocals drops from about 106 ms to under 5 ms.

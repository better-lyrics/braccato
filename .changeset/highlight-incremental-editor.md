---
"@braccato/highlight": patch
---

Make the editor overlay fast enough for live typing on large syllable-timed TTML. Adjacent tokens of the same type now render as one node, and each input rebuilds only the lines whose tokens changed, with every line laid out as its own block. A keystroke in a 320-line TTML with background vocals drops from about 100 ms to a few milliseconds.

The editor textarea is now forced to `box-sizing: border-box`, so a textarea with padding or borders no longer overflows the wrapper and drifts off the highlighted text.

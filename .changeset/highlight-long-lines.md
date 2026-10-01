---
"@braccato/highlight": patch
---

Make the editor overlay fast on very long lines, such as minified TTML stored on one line. A keystroke now rewrites only the text nodes whose tokens changed instead of rebuilding the whole line, and the input handler no longer forces a synchronous layout. Only the text near the visible part of the editor is coloured; the rest renders as plain text in the same font, so alignment is unchanged. A keystroke in a 21.4k-character one-line TTML drops from about 10 ms to under 3 ms, and in a 98k-character one from about 49 ms to under 7 ms.

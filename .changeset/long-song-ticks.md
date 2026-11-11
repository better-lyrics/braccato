---
"@braccato/core": patch
"@braccato/parsers": patch
---

Long songs play with less work per frame: off-screen lines are skipped from the positions relayout measured instead of an IntersectionObserver over every line, line animation checks stop building an array per line, and `TTMLParser.metadata` reuses the parse `TTMLParser.parse` just did on the same document.

---
"@braccato/core": patch
---

Split the Letter Wave animation on grapheme clusters instead of code points, so Devanagari, Bengali and other Indic scripts (and emoji sequences) keep each visual letter whole instead of breaking a consonant apart from its vowel signs.

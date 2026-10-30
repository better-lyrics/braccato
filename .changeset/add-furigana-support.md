---
"@braccato/core": minor
"@braccato/types": minor
"@braccato/furigana": minor
---

Add Japanese Kanji Furigana (ruby annotation) support:
- Add `@braccato/furigana` package with kana anchor / dictionary aligner and language detection
- Add `injectFurigana(doc, line, segments)` decorator in `@braccato/core` preserving letter waves and image highlights
- Add `RubySegment` shared interface in `@braccato/types`

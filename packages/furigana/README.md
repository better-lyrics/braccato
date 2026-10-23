# @braccato/furigana

Japanese Kanji furigana (ruby annotation) alignment engine for synchronized lyrics.

Given lyrics lines and romanization or timed pronunciation data, aligns kanji characters to their corresponding hiragana readings, producing structured ruby segments while respecting okurigana boundaries, small kana (拗音), sokuon (促音 `っ`), hatsuon (撥音 `ん`), jukujikun (熟字訓), and orthographic normalization rules.

## Installation

```bash
pnpm add @braccato/furigana
```

## Usage

```ts
import { alignLineParts, isJapaneseLine, songHasKana } from "@braccato/furigana";

// Check if lyrics belong to a Japanese song
if (isJapaneseLine(lineText, { declaredLanguage: "ja", songHasKana: true })) {
  const segmentsMap = alignLineParts(parts, timedRomanization, fullLineRomanization, fullLineText);
  // Returns Record<number, RubySegment[]>
}
```

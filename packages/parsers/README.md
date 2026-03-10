# @braccato/parsers

Lyrics format parsers for TTML, LRC, SRT, QRC, and plain text. Used by [`@braccato/core`](https://braccato.boidu.dev) for automatic format detection.

## Install

```bash
npm i @braccato/parsers
```

## Usage

```typescript
import { detectParser } from "@braccato/parsers";

const parser = detectParser(inputText);
const lyrics = parser.parse(inputText, durationMs);
```

Or use a specific parser directly:

```typescript
import { TTMLParser, LRCParser, SRTParser, QRCParser, PlainParser } from "@braccato/parsers";

const lyrics = TTMLParser.parse(ttmlString, durationMs);
```

## Parser Interface

All parsers implement:

```typescript
interface LyricParser {
  parse(input: string, duration?: number): Lyric[];
  detect(input: string): boolean;
}
```

`detectParser` tries each format in priority order: TTML, LRC, SRT, QRC, Plain.

See the [full documentation](https://braccato.boidu.dev) for type definitions.

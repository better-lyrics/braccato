# @braccato/parsers

Lyrics format parsers for TTML, LRC, SRT, QRC, and plain text, with automatic format detection. Produces the `Lyric[]` array that [`@braccato/core`](https://www.npmjs.com/package/@braccato/core) renders.

The [parsers guide](https://docs.betterlyrics.org/braccato/parsers) shows how to parse the response from each Better Lyrics API provider.

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

const lyrics = TTMLParser.parse(ttmlString);
```

## Parser Interface

All parsers implement:

```typescript
interface LyricParser {
  parse(input: string, duration?: number): Lyric[];
  metadata(input: string): LyricMetadata;
  detect(input: string): boolean;
}
```

`metadata` reads what the file says about the song rather than its lines, which today is who wrote it. `songwriters` is empty when the file credits nobody:

```typescript
const { songwriters } = detectParser(inputText).metadata(inputText); // ["Max Martin", "Savan Kotecha"]
```

| Format | Where the songwriters come from |
| --- | --- |
| TTML | `<songwriters>` in any metadata container (Apple's `iTunesMetadata`, lrc.red's `sourceMetadata`), and Composer's `<composer:meta key="songwriter">` |
| LRC | `[au:]` and `[lr:]`. `[by:]` names whoever made the file and is left out |
| QRC | Credit lines such as `作词:` or `Written by:`. Producer, mixing and the other roles are left out |
| SRT, Plain | Nothing |

Names that LRC and QRC hold as free text are split on `/`, `、`, `，` and `,`. Every format drops duplicates and keeps the order the file gives.

`detectParser` tries each format in priority order: TTML, LRC, SRT, QRC, Plain.

`TTMLParser.parse` ignores its `duration` argument, because a TTML document states its own duration on `<body dur>`. Pass a duration through `parseTTMLContent` instead when the document omits it.

## Format specifics

### TTML

`parseTTMLContent` returns the parsed lines along with whether the document is word synced and the language it declares:

```typescript
import { parseTTMLContent } from "@braccato/parsers";

const { lyrics, isWordSynced, language } = parseTTMLContent(ttmlString, {
  songDurationMs: 214000, // only used when <body> carries no dur
  instrumentalGapMs: 5000, // silence longer than this becomes an instrumental line
});
```

Instrumental lines are inserted whether or not the document states a duration. This changed in 0.2.0: 0.1.x only inserted them for a document whose `<body>` carried a `dur`, and the implementation this package was rewritten from does not gate them, so the gate is gone. A document with no `dur` now gains an intro instrumental when its first line starts more than `instrumentalGapMs` in, and one between any two lines separated by more than that. The outro is the exception, since nothing states where the song ends: pass `songDurationMs` to get it.

It reads syllable timing, `ttm:role="x-bg"` background vocals, `ttm:agent` (mapped to stable vocalist slots `v1`, `v2`, and `v1000` for a group), explicit flags from either `explicit` or AMLL's `obscene`, `itunes:key`, translations and transliterations. Namespace prefixes that a document uses without declaring are recovered rather than rejected, and times may be clock values or offset times such as `432.25s`, `5m` or `250ms`.

### LRC

`LRCParser.parse` runs a set of timing fixers suited to Musixmatch word by word lyrics. For a source whose timings are already clean, use `parseLRC`, which returns the document exactly as stated:

```typescript
import { parseLRC, lrcFixers } from "@braccato/parsers";

const lyrics = parseLRC(lrcText, durationMs);
lrcFixers(lyrics); // optional, mutates in place
```

### QRC

`QRCParser.parse` accepts either the `<QrcInfos>` envelope QQ Music returns or a bare QRC body. Pass song metadata through `parseQRC` to drop the opening lines that only echo the title or artist:

```typescript
import { parseQRC } from "@braccato/parsers";

const lyrics = parseQRC(qrcXml, durationMs, { title: "Song", artist: "Artist" });
```

Singer prefixes (`Name:` at the head of a line) become agents and are stripped from the text, sticking to the following lines until the next one appears. Credit lines are dropped.

See the [full documentation](https://braccato.boidu.dev) for type definitions.

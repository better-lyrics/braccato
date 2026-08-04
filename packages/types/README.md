# @braccato/types

The lyric data shapes shared by [`@braccato/core`](https://www.npmjs.com/package/@braccato/core) and
[`@braccato/parsers`](https://www.npmjs.com/package/@braccato/parsers). Types only: nothing here emits
runtime code, and a type-only import is erased at compile time, so it costs your bundle nothing.

You rarely install this directly. Both packages depend on it and re-export what they use, so
`import type { Lyric } from "@braccato/parsers"` goes on working.

```bash
npm i -D @braccato/types
```

```ts
import type { Lyric, LyricPart, LyricSyncType } from "@braccato/types";
```

## The shapes

`Lyric` is a line. `startTimeMs`, `words` and `durationMs` are the whole of the required surface;
everything else describes a capability a given source may or may not have.

| Field | Meaning |
| --- | --- |
| `startTimeMs` | When the line begins, in milliseconds |
| `words` | The full line as text, background vocals included |
| `durationMs` | How long the line lasts |
| `key` | The source's own id for the line, used to attach translations and romanizations |
| `parts` | Word or syllable timing. Its absence is what makes a line line-synced rather than rich-synced |
| `agent` | Which vocalist sings it, as `v1`, `v2`, … with `v1000` for a group |
| `translations` | Translated text by language code |
| `translation` | One translation with its language. Superseded by `translations` |
| `romanization` | The line romanized, untimed |
| `timedRomanization` | The line romanized, with the same part timing as `parts` |
| `isInstrumental` | A synthetic line standing in for a gap nobody sings over |

`LyricPart` is a word or syllable inside a line: `startTimeMs`, `words` and `durationMs`, plus
`isBackground` for backing vocals and `explicit` for a word a source has flagged.

`LyricSyncType` is `"richsync" | "synced" | "none"`, how finely a line is timed.
`@braccato/parsers` exports the same union as `SyncType`.

## Licence

MIT, with the rest of the repository.

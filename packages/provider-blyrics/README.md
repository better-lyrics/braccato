# @braccato/provider-blyrics

Lyrics provider chain with priority ordering and validation. Fetch synchronized lyrics from multiple sources with automatic fallback.

## Install

```bash
npm i @braccato/provider-blyrics
```

## Usage

```typescript
import { ProviderChain, createLRCLibSyncedProvider } from "@braccato/provider-blyrics";

const chain = new ProviderChain();
chain.register("lrclib-synced", createLRCLibSyncedProvider());

const result = await chain.fetchLyrics(
  { song: "Title", artist: "Artist", duration: 240 },
  { signal: abortController.signal }
);
```

## Built-in Providers

```typescript
import {
  createBLyricsProvider,
  createLRCLibSyncedProvider,
  createLRCLibPlainProvider,
  createLegatoProvider,
  createBinimumProvider,
  createPortatoProvider,
  createUnisonProvider,
} from "@braccato/provider-blyrics";
```

`createUnisonProvider` matches on `videoId`, so pass it on the context when you have one:

```typescript
const result = await chain.fetchLyrics(
  { song: "Title", artist: "Artist", duration: 240, videoId: "dQw4w9WgXcQ" },
  { signal: abortController.signal }
);
```

## Validation

Validate fetched lyrics against a reference to prevent wrong matches:

```typescript
import { createSimilarityValidator } from "@braccato/provider-blyrics";

const validate = createSimilarityValidator(referenceText, 0.5);
const result = await chain.fetchLyrics(context, { validate });
```

See the [full documentation](https://braccato.boidu.dev) for details.

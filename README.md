<p align="center">
  <img src="demo/public/icons/icon-512.png" alt="Braccato" height="48" />
</p>

<h1 align="center">Braccato</h1>

<p align="center">
  Synchronized lyrics rendering as a web component.<br>
  <a href="https://www.npmjs.com/package/@braccato/core"><code>@braccato/core</code></a>, the word-by-word lyrics renderer from <a href="https://better-lyrics.boidu.dev">Better Lyrics</a>, with the parsers, providers and tooling around it.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@braccato/core"><img src="https://img.shields.io/npm/v/@braccato/core?style=flat-square&label=core&color=F50032" alt="@braccato/core on npm" /></a>
  <a href="https://www.npmjs.com/package/@braccato/parsers"><img src="https://img.shields.io/npm/v/@braccato/parsers?style=flat-square&label=parsers&color=F50032" alt="@braccato/parsers on npm" /></a>
  <a href="https://www.npmjs.com/package/@braccato/provider-blyrics"><img src="https://img.shields.io/npm/v/@braccato/provider-blyrics?style=flat-square&label=provider-blyrics&color=F50032" alt="@braccato/provider-blyrics on npm" /></a>
  <a href="https://www.npmjs.com/package/@braccato/rics"><img src="https://img.shields.io/npm/v/@braccato/rics?style=flat-square&label=rics&color=F50032" alt="@braccato/rics on npm" /></a>
  <a href="https://www.npmjs.com/package/@braccato/types"><img src="https://img.shields.io/npm/v/@braccato/types?style=flat-square&label=types&color=F50032" alt="@braccato/types on npm" /></a>
</p>

<p align="center">
  <a href="https://braccato.boidu.dev"><img src="https://img.shields.io/badge/Demo-braccato.boidu.dev-F50032?style=flat-square" alt="Demo" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-2196f3?style=flat-square" alt="MIT License" /></a>
  <a href="https://better-lyrics.boidu.dev"><img src="https://img.shields.io/badge/Built%20for-Better%20Lyrics-F50032?style=flat-square" alt="Built for Better Lyrics" /></a>
</p>

> [!IMPORTANT]
> `@braccato/core` 1.0.0 is a rewrite, not a version bump. If you are on 0.1.x, read
> [MIGRATION.md](MIGRATION.md) before upgrading.

## Packages

| Package | Description |
|---------|-------------|
| `@braccato/core` | The `<braccato-lyrics>` element: synchronized lyrics, word by word |
| `@braccato/parsers` | Format parsers: TTML, LRC, SRT, QRC, Plain |
| `@braccato/provider-blyrics` | Lyrics provider chain with priority and validation |
| `@braccato/rics` | RICS CSS preprocessor |
| `@braccato/types` | The lyric shapes core and parsers share |

`@braccato/core`, the `<braccato-lyrics>` element itself, is [`packages/core`](packages/core). It
moved here from the [Better Lyrics repository](https://github.com/better-lyrics/better-lyrics), where
the rendering engine still runs as part of the extension. Its
[README](packages/core/README.md) is the reference for properties, attributes, events, theming and
class names.

`playground/` has been retired. The page it served,
[braccato.boidu.dev](https://braccato.boidu.dev), is now [`demo/`](demo), beside the renderer it
demonstrates. Run `pnpm -C demo dev` and open `http://localhost:5173/`, or build it with
`pnpm -C demo build`. It deploys from Cloudflare Pages, which builds `pnpm build` at the repository
root and serves `demo/dist`.

## Quick start

```html
<audio id="player" src="song.mp3" controls></audio>
<braccato-lyrics source="#player"></braccato-lyrics>

<script type="module">
  import "@braccato/core/element";
  import "@braccato/core/styles/variables.css";
  import "@braccato/core/styles/lyrics.css";
  import "@braccato/core/styles/instrumental.css";
  import { detectParser } from "@braccato/parsers";

  const el = document.querySelector("braccato-lyrics");
  const player = document.querySelector("#player");

  const text = await fetch("lyrics.ttml").then((r) => r.text());
  el.lyrics = detectParser(text).parse(text, player.duration * 1000);
</script>
```

```css
braccato-lyrics {
  display: block;
  overflow-y: auto;
}

.blyrics-container {
  padding-top: var(--blyrics-padding-top, 2rem);
}
```

`source` takes a CSS selector or a media element, and while it is bound the element reads the clock
itself and seeks the player when a line is clicked. Without one, drive it by writing `currentTime`
(in **seconds**) and `playing`.

The element renders into light DOM, so your own stylesheet reaches the lines. Theming is a
stylesheet you hand to `el.theme`.

## Framework examples

`<braccato-lyrics>` is a plain custom element with no framework runtime behind it, so there is no
wrapper to install anywhere. Two things are true in every framework:

- `source`, `playing`, `current-time` and `theme` are attributes, so ordinary template syntax works.
- `lyrics` is a property that takes an array, so it goes through a ref rather than a template
  binding. Frameworks disagree about when a template binding becomes a property, and a ref does not.

### React

```tsx
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { detectParser } from "@braccato/parsers";
import { useEffect, useRef } from "react";

function Lyrics({ lyricsUrl }: { lyricsUrl: string }) {
  const ref = useRef<HTMLElement & { lyrics: unknown[] }>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(lyricsUrl)
      .then((r) => r.text())
      .then((text) => {
        if (!cancelled && ref.current) {
          ref.current.lyrics = detectParser(text).parse(text);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [lyricsUrl]);

  return (
    <>
      <audio id="player" src="/song.mp3" controls />
      <braccato-lyrics ref={ref} source="#player" />
    </>
  );
}
```

For typed JSX:

```ts
declare namespace JSX {
  interface IntrinsicElements {
    "braccato-lyrics": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        source?: string;
        theme?: string;
        playing?: boolean;
        "current-time"?: number;
      },
      HTMLElement
    >;
  }
}
```

### Vue

```vue
<template>
  <audio id="player" src="/song.mp3" controls />
  <braccato-lyrics ref="view" source="#player" />
</template>

<script setup>
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { detectParser } from "@braccato/parsers";
import { onMounted, ref } from "vue";

const view = ref(null);

onMounted(async () => {
  const text = await fetch("/lyrics.ttml").then((r) => r.text());
  view.value.lyrics = detectParser(text).parse(text);
});
</script>
```

Tell Vue to treat `braccato-lyrics` as a custom element in `vite.config.ts`:

```ts
vue({
  template: {
    compilerOptions: {
      isCustomElement: (tag) => tag === "braccato-lyrics",
    },
  },
})
```

### Svelte

```svelte
<script>
  import "@braccato/core/element";
  import "@braccato/core/styles/variables.css";
  import "@braccato/core/styles/lyrics.css";
  import "@braccato/core/styles/instrumental.css";
  import { detectParser } from "@braccato/parsers";
  import { onMount } from "svelte";

  let view;

  onMount(async () => {
    const text = await fetch("/lyrics.ttml").then((r) => r.text());
    view.lyrics = detectParser(text).parse(text);
  });
</script>

<audio id="player" src="/song.mp3" controls />
<braccato-lyrics bind:this={view} source="#player" />
```

### Vanilla JS (manual clock)

Without a `source`, you own the clock. `currentTime` is in seconds.

```js
import "@braccato/core/element";
import "@braccato/core/styles/variables.css";
import "@braccato/core/styles/lyrics.css";
import "@braccato/core/styles/instrumental.css";
import { TTMLParser } from "@braccato/parsers";

const el = document.querySelector("braccato-lyrics");
const audio = document.querySelector("audio");

const res = await fetch("/lyrics.ttml");
el.lyrics = TTMLParser.parse(await res.text(), audio.duration * 1000);

function loop() {
  el.currentTime = audio.currentTime;
  el.playing = !audio.paused;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

## Parsers

All parsers implement the `LyricParser` interface:

```typescript
interface LyricParser {
  parse(input: string, duration?: number): Lyric[];
  detect(input: string): boolean;
}
```

Available parsers:

```typescript
import { TTMLParser, LRCParser, SRTParser, QRCParser, PlainParser } from "@braccato/parsers";
```

Use `detectParser` for automatic format detection (priority: TTML, LRC, SRT, QRC, Plain):

```typescript
import { detectParser } from "@braccato/parsers";

const parser = detectParser(inputText);
const lyrics = parser.parse(inputText, durationMs);
```

### Core types

Declared in `@braccato/types`, which both `@braccato/core` and `@braccato/parsers` depend on and
re-export, so importing `Lyric` from either goes on working.

```typescript
interface Lyric {
  startTimeMs: number;
  words: string;
  durationMs: number;
  key?: string;
  parts?: LyricPart[];
  agent?: string;
  translations?: { [lang: string]: string };
  translation?: { text: string; lang: string };
  romanization?: string;
  timedRomanization?: LyricPart[];
  isInstrumental?: boolean;
}

interface LyricPart {
  startTimeMs: number;
  words: string;
  durationMs: number;
  isBackground?: boolean;
  explicit?: boolean;
}
```

## Provider chain

Fetch lyrics from multiple sources with priority ordering and validation:

```typescript
import { ProviderChain, createLRCLibSyncedProvider } from "@braccato/provider-blyrics";

const chain = new ProviderChain();
chain.register("lrclib-synced", createLRCLibSyncedProvider());

const result = await chain.fetchLyrics(
  { song: "Title", artist: "Artist", duration: 240000 },
  { signal: abortController.signal }
);
```

### Built-in providers

```typescript
import {
  createBLyricsProvider,
  createLRCLibSyncedProvider,
  createLRCLibPlainProvider,
  createLegatoProvider,
} from "@braccato/provider-blyrics";
```

### Validation

Validate fetched lyrics against a reference to prevent wrong matches:

```typescript
import { createSimilarityValidator } from "@braccato/provider-blyrics";

const validate = createSimilarityValidator(referenceText, 0.5);
const result = await chain.fetchLyrics(context, { validate });
```

## RICS CSS preprocessor

Compile RICS source code to CSS:

```typescript
import { compileRics, compileRicsToCSS } from "@braccato/rics";

const result = compileRics(ricsSource, { timeout: 3000 });
// result.css, result.errors, result.timedOut

const css = compileRicsToCSS(ricsSource);
```

## Development

```bash
pnpm install
pnpm dev              # Watch all packages
pnpm build            # Build all packages
pnpm test             # Run tests
pnpm selfcheck        # Run the renderer's self-checks
pnpm lint             # Biome linting
pnpm lint:fix         # Auto-fix
pnpm typecheck        # TypeScript checks

pnpm package          # Emit the @braccato/core artifact to packages/core/dist
pnpm -C demo dev      # Serve the page at http://localhost:5173/
pnpm -C demo build    # Build the page to demo/dist
```

The demo is a workspace member, so `pnpm dev` and `pnpm build` reach it too. Either way its own
`predev` and `prebuild` synthesize the demo audio first, which is generated rather than committed.

## Project structure

```
braccato/
  packages/
    core/              # The <braccato-lyrics> element and the renderer behind it
    parsers/           # TTML, LRC, SRT, QRC, Plain parsers
    provider-blyrics/  # Provider chain + built-in providers
    rics/              # RICS CSS preprocessor
    types/             # The lyric shapes core and parsers share
  demo/                # The page behind braccato.boidu.dev, a workspace Vite app
  tooling/             # Package emit, API doc check, audio generator, self-checks
```

`@braccato/core` is built rather than bundled: `tooling/build-package.ts` emits `packages/core/dist`
with tsc, and the manifest beside it names those files. The emit fails if a subpath the manifest
promises is not a file it produced.

## Acknowledgments

Inspired by [apple-music-web-components](https://github.com/binimum/apple-music-web-components) by [@binimum](https://github.com/binimum).

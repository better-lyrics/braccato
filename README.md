<p align="center">
  <img src="https://api.iconify.design/mingcute:music-3-line.svg?color=%23a78bfa&height=48" alt="Braccato" />
</p>

<h1 align="center">Braccato</h1>

<p align="center">
  Synchronized lyrics rendering as a web component.<br>
  Word-by-word animated lyrics with any audio source, extracted from the <a href="https://better-lyrics.boidu.dev">Better Lyrics</a> rendering engine.
</p>

## Quick Start

```html
<audio id="player" src="song.mp3" controls></audio>
<braccato-lyrics source="#player" src="lyrics.ttml"></braccato-lyrics>

<script type="module">
  import "@braccato/core";
</script>
```

The `source` attribute accepts a CSS selector for any `<audio>` or `<video>` element. The component handles playback sync, seeking on line click, and animation timing automatically. The `src` attribute fetches and parses a lyrics file (TTML, LRC, SRT, QRC, or plain text are auto-detected).

For full control, set `lyrics`, `currentTime`, and `playing` directly instead:

```html
<script type="module">
  import "@braccato/core";
  import { LRCParser } from "@braccato/parsers";

  const el = document.querySelector("braccato-lyrics");
  el.lyrics = LRCParser.parse(lrcText, durationMs);
  el.currentTime = 5000; // ms
  el.playing = true;
</script>
```

## Framework Examples

### React

```tsx
import "@braccato/core";
import { useRef, useEffect } from "react";

function Lyrics({ lyricsUrl }: { lyricsUrl: string }) {
  return (
    <>
      <audio id="player" src="/song.mp3" controls />
      <braccato-lyrics source="#player" src={lyricsUrl} />
    </>
  );
}
```

For typed props, add a declaration:

```ts
declare namespace JSX {
  interface IntrinsicElements {
    "braccato-lyrics": React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        source?: string;
        src?: string;
        playing?: boolean;
        "current-time"?: number;
        "scroll-mode"?: "internal" | "external";
        dir?: "auto" | "ltr" | "rtl";
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
  <braccato-lyrics source="#player" :src="lyricsUrl" />
</template>

<script setup>
import "@braccato/core";

const lyricsUrl = "/lyrics.ttml";
</script>
```

Tell Vue to treat `braccato-lyrics` as a custom element in `vite.config.ts`:

```ts
vue({
  template: {
    compilerOptions: {
      isCustomElement: (tag) => tag.startsWith("braccato-"),
    },
  },
})
```

### Svelte

```svelte
<script>
  import "@braccato/core";
  let lyricsUrl = "/lyrics.ttml";
</script>

<audio id="player" src="/song.mp3" controls />
<braccato-lyrics source="#player" src={lyricsUrl} />
```

### Vanilla JS (manual sync)

```js
import "@braccato/core";
import { TTMLParser } from "@braccato/parsers";

const el = document.querySelector("braccato-lyrics");
const audio = document.querySelector("audio");

// Load lyrics
const res = await fetch("/lyrics.ttml");
el.lyrics = TTMLParser.parse(await res.text(), audio.duration * 1000);

// Sync loop
function loop() {
  el.currentTime = audio.currentTime * 1000;
  el.playing = !audio.paused;
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
```

## Packages

| Package | Description |
|---------|-------------|
| `@braccato/core` | `<braccato-lyrics>` web component (Lit) |
| `@braccato/parsers` | Format parsers: TTML, LRC, SRT, QRC, Plain |
| `@braccato/provider-blyrics` | Lyrics provider chain with priority and validation |
| `@braccato/rics` | RICS CSS preprocessor |

## Component API

### Properties

| Property | Attribute | Type | Default | Description |
|----------|-----------|------|---------|-------------|
| `source` | `source` | `string \| null` | `null` | CSS selector for the media element to sync with |
| `src` | `src` | `string \| null` | `null` | URL to a lyrics file (auto-detected format) |
| `lyrics` | | `Lyric[]` | `[]` | Parsed lyric data (set directly for manual control) |
| `currentTime` | `current-time` | `number` | `0` | Playback position in ms (ignored when `source` is set) |
| `playing` | `playing` | `boolean` | `false` | Whether playback is active (ignored when `source` is set) |
| `scrollMode` | `scroll-mode` | `'internal' \| 'external'` | `'internal'` | Scroll container ownership |
| `scrollContainer` | | `HTMLElement \| null` | `null` | External scroll container |
| `dir` | `dir` | `'auto' \| 'ltr' \| 'rtl'` | `'auto'` | Text direction |
| `longWordThreshold` | `long-word-threshold` | `number` | `1500` | Duration (ms) for long word glow |
| `lineSyncedDelay` | `line-synced-delay` | `number` | `50` | Delay for line-synced animation |
| `disableRichsync` | `disable-richsync` | `boolean` | `false` | Force line-level sync even with word data |

### Events

| Event | Detail | Description |
|-------|--------|-------------|
| `braccato:line-click` | `{ time, lineIndex }` | User clicked a lyric line |
| `braccato:word-click` | `{ time, lineIndex, wordIndex }` | Alt+click on a word (rich sync) |
| `braccato:lyrics-loaded` | `{ syncType, lineCount }` | Lyrics injected into the DOM |
| `braccato:scroll-state` | `{ userScrolling }` | Scroll state changed |
| `braccato:error` | `{ error }` | Fetch or parse error (when using `src`) |

### CSS Custom Properties

```css
braccato-lyrics {
  --braccato-font-family: system-ui, sans-serif;
  --braccato-font-size: 3rem;
  --braccato-font-weight: 600;
  --braccato-line-height: 1.333;
  --braccato-active-color: white;
  --braccato-inactive-opacity: 0.3;
  --braccato-glow-color: rgba(255, 255, 255, 0.5);
  --braccato-scale: 0.95;
  --braccato-active-scale: 1;
  --braccato-timing-offset: 0.115s;
  --braccato-richsync-timing-offset: 0.150s;
  --braccato-scroll-timing-offset: 0.5s;
  --braccato-scroll-duration: 750ms;
  --braccato-wobble-duration: 1s;
  --braccato-highlight-fade-in-duration: 0.33s;
  --braccato-scale-transition-duration: 0.166s;
}
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

### Core Types

```typescript
interface Lyric {
  startTimeMs: number;
  words: string;
  durationMs: number;
  parts?: LyricPart[];
  agent?: string;
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
}
```

## Provider Chain

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

### Built-in Providers

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

## RICS CSS Preprocessor

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
pnpm dev:playground   # Run playground
pnpm build            # Build all packages
pnpm test             # Run tests
pnpm lint             # Biome linting
pnpm lint:fix         # Auto-fix
pnpm typecheck        # TypeScript checks
```

## Project Structure

```
braccato/
  packages/
    core/              # <braccato-lyrics> web component (Lit)
    parsers/           # TTML, LRC, SRT, QRC, Plain parsers
    provider-blyrics/  # Provider chain + built-in providers
    rics/              # RICS CSS preprocessor
  playground/          # Interactive demo (Vite)
```

# @braccato/core

`<braccato-lyrics>` web component for synchronized lyrics rendering with word-by-word animations. Built with Lit, extracted from the [Better Lyrics](https://better-lyrics.boidu.dev) rendering engine.

## Install

```bash
npm i @braccato/core
```

## Usage

```html
<audio id="player" src="song.mp3" controls></audio>
<braccato-lyrics source="#player" src="lyrics.ttml"></braccato-lyrics>

<script type="module">
  import "@braccato/core";
</script>
```

The `source` attribute accepts a CSS selector for any `<audio>` or `<video>` element. The `src` attribute fetches and parses a lyrics file (TTML, LRC, SRT, QRC, or plain text are auto-detected).

For manual control, set `lyrics`, `currentTime`, and `playing` directly instead.

## Properties

| Property | Attribute | Type | Default | Description |
|----------|-----------|------|---------|-------------|
| `source` | `source` | `string \| null` | `null` | CSS selector for the media element to sync with |
| `src` | `src` | `string \| null` | `null` | URL to a lyrics file (auto-detected format) |
| `lyrics` | | `Lyric[]` | `[]` | Parsed lyric data (set directly for manual control) |
| `currentTime` | `current-time` | `number` | `0` | Playback position in ms (ignored when `source` is set) |
| `playing` | `playing` | `boolean` | `false` | Whether playback is active (ignored when `source` is set) |
| `scrollMode` | `scroll-mode` | `'internal' \| 'external'` | `'internal'` | Scroll container ownership |
| `dir` | `dir` | `'auto' \| 'ltr' \| 'rtl'` | `'auto'` | Text direction |

## Events

| Event | Detail | Description |
|-------|--------|-------------|
| `braccato:line-click` | `{ time, lineIndex }` | User clicked a lyric line |
| `braccato:word-click` | `{ time, lineIndex, wordIndex }` | Alt+click on a word (rich sync) |
| `braccato:lyrics-loaded` | `{ syncType, lineCount }` | Lyrics injected into the DOM |
| `braccato:scroll-state` | `{ userScrolling }` | Scroll state changed |
| `braccato:error` | `{ error }` | Fetch or parse error (when using `src`) |

## CSS Custom Properties

```css
braccato-lyrics {
  --braccato-font-family: system-ui, sans-serif;
  --braccato-font-size: 3rem;
  --braccato-font-weight: 600;
  --braccato-active-color: white;
  --braccato-inactive-opacity: 0.3;
  --braccato-glow-color: rgba(255, 255, 255, 0.5);
  --braccato-timing-offset: 0.115s;
  --braccato-richsync-timing-offset: 0.150s;
}
```

See the [full documentation](https://braccato.boidu.dev) for all properties and framework examples.

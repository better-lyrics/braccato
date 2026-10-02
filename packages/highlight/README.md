# @braccato/highlight

Syntax highlighting for TTML, LRC, QRC and SRT lyrics, with zero runtime dependencies beyond `@braccato/parsers/format`. It ships a pure tokenizer, a DOM renderer for read-only panes, and a textarea overlay for editors. Stamps and markup recede, and the sung words stay bright.

## Install

```bash
npm i @braccato/highlight
```

## Usage

### Read-only panes

```typescript
import { highlightInto } from "@braccato/highlight";
import "@braccato/highlight/highlight.css";

highlightInto(pre, source, { pretty: true });
```

`highlightInto` adds the `bh` class to the element, which the token colours are scoped under, and returns the format it used. `pretty: true` breaks minified TTML into lines at `head`, `body`, `div` and `p`. It only inserts whitespace, but the rendered text no longer matches the source, so use it for display only and never in an editor. Line formats ignore it.

### Editors

```typescript
import { attachEditor } from "@braccato/highlight";
import "@braccato/highlight/highlight.css";

const editor = attachEditor(textarea);
```

`attachEditor` wraps the textarea in a `div.bh-edit` and lays a highlighted `pre.bh-layer` under it. The textarea becomes transparent and keeps the caret, the selection and all input. The layer copies the textarea's font, padding, border widths and box sizing on every input and on every resize, and follows its scroll position.

The layer holds one `span.bh-line` block per source line, and each block holds a single text node. The colours come from the [CSS Custom Highlight API](https://developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API): one highlight per token type, registered in `CSS.highlights` as `bh-<type>` and shared by every editor on the page. Splitting a line into elements would make the browser round each piece's width separately, and a row that only just fits in the textarea would then wrap one word early in the layer and push every later line down a row. A single text node is laid out exactly as the textarea lays out its value. Where the API is missing, the layer shows plain text in the same position.

Every input re-tokenizes the whole document, so TTML state such as background vocals stays correct on later lines, but only the lines that changed are rewritten and recoloured.

Only the text within one editor height above and below the visible part is coloured. The rest has no highlight ranges. A scroll that stays inside that margin restyles once scrolling settles, and a scroll past it restyles before the next paint.

Keystroke cost in Chrome 152 on an Apple M4 Pro, for a keystroke typed mid-document in a 900 by 600 pixel editor. Script and layout is the median script plus forced style and layout time; paint is the paint phase of the frame that follows:

| Document | Script and layout | Paint |
|---|---|---|
| 21.4k-character one-line TTML | 2.8 ms | 17 ms |
| 98k-character one-line TTML | 7.1 ms | 26 ms |
| 320-line TTML | 3.2 ms | 1.6 ms |
| 2,000-line LRC | 3.6 ms | 1.3 ms |

A keystroke repaints the whole text node it lands in, with every highlight on it, so one long line is the slow case: the visible text repaints in one piece per token.

Scrolling restyles once per editor height scrolled. On the 98k-character line that restyle costs about one and a half keystrokes, and on the multi-line documents less than one; scroll steps in between cost under 0.2 ms.

The package is 10.9 KB minified and 4.7 KB gzipped (`esbuild --minify`), plus `@braccato/parsers/format`.

It returns `{ wrap, layer, refresh, setFormat, destroy }`:

- Setting `textarea.value` from code does not fire `input`, so call `editor.refresh()` after every programmatic write.
- `editor.destroy()` puts the textarea back where it was, removes the wrapper and drops the `bh-input` class. Calling it twice is safe.
- Pass `{ format }` to pin a format. Without it the format is detected on every render, so pasting a different format re-colours.
- The editor copies the options when it attaches and owns its format from then on. Changing the options object later does nothing.
- `editor.setFormat(format)` changes the format of the live editor and re-renders at once. The textarea is not re-attached, so its native undo history survives. `editor.setFormat(undefined)` goes back to detecting the format on every render. Passing the current fixed format (or `undefined` while detecting) does nothing. In detect mode, passing the format that was detected pins it. `setFormat` does not replace `refresh()` after a programmatic write to `textarea.value`: call `refresh()` for the new value whether or not the format changes.
- Attaching a textarea that already has a live editor returns that editor's handle and ignores the new options. Use `setFormat` on the handle to change the format.

The overlay needs the textarea and the layer to share one box, so `.bh-input` forces `margin: 0`, `box-sizing: border-box`, `width: 100%` and `resize: none` on the textarea. The layer copies that box sizing, so a textarea's padding and borders stay inside the wrapper and both wrap lines at the same width. Put any margin or width the host wants on the wrapper (`.bh-edit`, or `editor.wrap`) instead.

Highlights can only change colours, so background vocals and comments are not italic in the editor, and `--bh-bgText-style` only applies to read-only panes. Any font works: the layer never changes the font of any part of the text.

### Tokens only

```typescript
import { tokenize } from "@braccato/highlight";

const tokens = tokenize(source); // [{ type: "punct", text: "[" }, { type: "timestamp", text: "00:14.21" }, ...]
```

The tokens' concatenated text always equals the input, and no two adjacent tokens share a type. They are exactly what `highlightInto` draws, so a renderer of your own (a React component that renders on the server, for example) reproduces it by drawing each token as below, with no merging step:

```tsx
tokens.map(({ type, text }, i) => (type === "text" ? text : <span key={i} className={`bh-${type}`}>{text}</span>));
```

Wrap the result in an element with the `bh` class so the token colours apply. `highlightInto` with `pretty: true` tokenizes `prettyTtml(source)` instead of the source.

## Tokens

In read-only panes each token renders as one `<span class="bh-<type>">`, except `text`, which renders as a plain text node. In the editor each token is a range in the `bh-<type>` highlight. `tokenize` already joins adjacent text of the same type into one token.

| Token | Meaning |
|---|---|
| `text` | Sung lyric text. It is also used for whitespace and newlines. |
| `bgText` | Sung text inside a TTML `ttm:role="x-bg"` span. |
| `timestamp` | A line time: `[00:14.21]`, a TTML `begin`, `end` or `dur` value, `[14210,4350]`, or an SRT cue time. |
| `wordTime` | A word time: `<00:18.90>` or `(14210,300)`. |
| `agent` | A voice: `v1:` in LRC, or TTML `ttm:agent`, `ttm:role` or `xml:id` values. |
| `meta` | Metadata: an LRC or QRC `[ti:...]` key, text inside the TTML `<head>`, or an SRT cue number. |
| `tag` | A TTML element name. |
| `attr` | A TTML attribute name. |
| `value` | Any other attribute value, or an LRC meta value. |
| `punct` | Brackets, quotes, `<` `>` `/` `=`, and the SRT `-->`. |
| `comment` | `<!-- ... -->` and `<?xml ... ?>`. |

## Theming

Every colour is a CSS custom property with a built-in fallback. The stylesheet defines no global custom properties, so set any of them on any ancestor of the pane:

```css
.my-pane { --bh-timestamp: #86efac; }
```

| Property | Default |
|---|---|
| `--bh-text` | `rgba(255, 255, 255, 0.95)` |
| `--bh-bgText` | `rgba(255, 255, 255, 0.82)` |
| `--bh-bgText-style` | `italic` |
| `--bh-timestamp` | `rgba(165, 180, 252, 0.7)` |
| `--bh-wordTime` | `rgba(165, 180, 252, 0.52)` |
| `--bh-agent` | `rgba(252, 211, 77, 0.45)` |
| `--bh-meta` | `rgba(249, 168, 212, 0.38)` |
| `--bh-tag` | `rgba(255, 255, 255, 0.26)` |
| `--bh-attr` | `rgba(255, 255, 255, 0.22)` |
| `--bh-value` | `rgba(134, 239, 172, 0.3)` |
| `--bh-punct` | `rgba(255, 255, 255, 0.16)` |
| `--bh-comment` | `rgba(255, 255, 255, 0.2)` |
| `--bh-caret` | `#fff` |
| `--bh-selection` | `rgba(165, 180, 252, 0.28)` |
| `--bh-placeholder` | `rgba(255, 255, 255, 0.35)` |

## Detection

When no format is given, it is detected with `detectFormat` from `@braccato/parsers/format`. Those are the same rules `detectParser` uses, in the same priority: TTML, LRC, SRT, QRC, then plain. The subpath is dependency-free, so highlighting never pulls in the XML parser.

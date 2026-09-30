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

`attachEditor` wraps the textarea in a `div.bh-edit` and lays a highlighted `pre.bh-layer` under it. The textarea becomes transparent and keeps the caret, the selection and all input. The layer copies the textarea's font, padding, border widths and box sizing on every render and on every resize, and follows its scroll position.

Every input re-tokenizes the whole document, so TTML state such as background vocals stays correct on later lines, but only the lines whose tokens changed are rebuilt. The layer holds one `span.bh-line` block per source line, so an edit lays out only the lines it touched.

It returns `{ wrap, layer, refresh, destroy }`:

- Setting `textarea.value` from code does not fire `input`, so call `editor.refresh()` after every programmatic write.
- `editor.destroy()` puts the textarea back where it was, removes the wrapper and drops the `bh-input` class. Calling it twice is safe.
- Attaching a textarea that already has a live editor returns that editor's handle.
- Pass `{ format }` to pin a format. Without it the format is detected on every render, so pasting a different format re-colours.

The overlay needs the textarea and the layer to share one box, so `.bh-input` forces `margin: 0`, `width: 100%` and `resize: none` on the textarea. Put any margin or width the host wants on the wrapper (`.bh-edit`, or `editor.wrap`) instead.

Use a monospace font on highlighted editors. Background vocals render in italics, and italics change glyph widths in proportional fonts, which moves the layer off the caret.

### Tokens only

```typescript
import { tokenize } from "@braccato/highlight";

const tokens = tokenize(source); // [{ type: "punct", text: "[" }, { type: "timestamp", text: "00:14.21" }, ...]
```

Without `pretty`, the tokens' concatenated text always equals the input.

## Tokens

Adjacent tokens of the same type render as one `<span class="bh-<type>">`, except `text`, which renders as a plain text node.

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

# Migrating to `@braccato/core` 1.0.0

`@braccato/core` 0.1.x was a Lit component published from this repository, at `packages/core`. That
package is gone. Version 1.0.0 is the Better Lyrics rendering engine itself, published from
[better-lyrics/better-lyrics](https://github.com/better-lyrics/better-lyrics/tree/master/src/renderer),
and it is not a drop-in replacement. This is the list of what changed and the edit you make for each.

The tag name is still `braccato-lyrics`, and `better-lyrics` is registered as an alias. `Lyric` and
`LyricPart` still have the same shape, so lyrics you already parse still load.

**`@braccato/parsers`, `@braccato/rics` and `@braccato/provider-blyrics` are unchanged** and stay in
this repository. Parsing moved *to* `@braccato/parsers`, not away from it.

## Before you start

1.0.0 is not on npm yet. `pnpm add @braccato/core@^1.0.0` will not resolve until the Better Lyrics
repository publishes it. Until then, see [Developing before 1.0.0 is published](#developing-before-100-is-published).

## The short version

```diff
-import "@braccato/core";
+import "@braccato/core/element";
+import "@braccato/core/styles/variables.css";
+import "@braccato/core/styles/lyrics.css";
+import "@braccato/core/styles/instrumental.css";
```

```diff
-<braccato-lyrics source="#player" src="lyrics.ttml"></braccato-lyrics>
+<braccato-lyrics source="#player"></braccato-lyrics>
```

```css
braccato-lyrics {
  display: block;
}
```

```js
view.currentTime = audio.currentTime; // seconds, not milliseconds
```

Then rename `--braccato-*` to `--blyrics-*` and `.braccato*` to `.blyrics*` throughout your CSS.

---

## 1. Light DOM instead of shadow DOM

This is the headline change and the reason for most of the others. 0.1.x was a `LitElement` that
built its lines into a shadow root, so your stylesheet could not reach them and the only styling
surface was `::part(container)` and the custom properties that pierced the boundary. 1.0.0 builds
into the element itself.

```css
/* Before */
braccato-lyrics::part(container) { padding: 2rem; }

/* After */
.blyrics-container { padding: 2rem; }
```

Everything follows from this. Your stylesheets now select the lines directly, the package's own
`@property` registrations apply to them (they did not inside a shadow root), and the package's
stylesheets are yours to load rather than bundled into the component.

There is no `part` attribute on anything. Select the class names instead.

## 2. The element has no `display`, and the stylesheets are yours to load

0.1.x carried `:host { display: block; overflow-y: auto; container-type: size; }` inside its shadow
stylesheet. 1.0.0 ships no rule for the tag at all, so an element with no CSS is an inline box with
unstyled text in it.

```css
braccato-lyrics {
  display: block;
  /* Only if you want the element itself to be the scroller. See section 6. */
  overflow-y: auto;
}
```

Three stylesheets ship with the package and you load them, in this order:

```js
import "@braccato/core/styles/variables.css";  // every --blyrics-* default, must come first
import "@braccato/core/styles/lyrics.css";     // container, lines, words, the sweep
import "@braccato/core/styles/instrumental.css"; // the waveform for instrumental bars
```

One rule they do not supply. The engine measures how much room the first and last lines need to
reach the target scroll position and writes both onto the root, but `lyrics.css` only spends the
bottom one:

```css
.blyrics-container {
  padding-top: var(--blyrics-padding-top, 2rem);
}
```

Without it the first lines of a song cannot scroll into position.

## 3. Importing the package no longer registers the tag

0.1.x had one entry point and registering `braccato-lyrics` was a side effect of importing it.
1.0.0 splits the facade from the registration, so a consumer that only wants
`createLyricsRenderer` does not get a custom element definition with it.

```diff
-import "@braccato/core";
+import "@braccato/core/element";
```

`@braccato/core` is now the facade: `createLyricsRenderer`, `resetPlaybackClock`,
`resumeAllAutoscroll`, `injectRomanization`, `injectTranslation`, and the types. Four more entry
points import nothing at all, so reaching for one does not pull the engine into your bundle:
`@braccato/core/constants`, `/text`, `/themeSettings` and `/util`.

Two things worth knowing. A browser extension's isolated world has no custom element registry, so
importing `@braccato/core/element` there throws; call `createLyricsRenderer` directly instead. And
two copies of the package on one page means the first to load takes both tag names.

## 4. `currentTime` is in seconds

0.1.x took milliseconds. 1.0.0 takes seconds, which is what `HTMLMediaElement.currentTime` is
already in, so the conversion disappears rather than moving.

```diff
-el.currentTime = audio.currentTime * 1000;
+el.currentTime = audio.currentTime;
```

Nothing about this fails loudly. A view given milliseconds sits past the end of the song and never
highlights anything, so check every write.

The `current-time` attribute is seconds too. A value that does not parse as a number is now ignored
rather than read as zero.

## 5. No `src`: parse with `@braccato/parsers` and set `lyrics`

0.1.x fetched a lyrics file and parsed it for you, which is why it depended on `@braccato/parsers`.
1.0.0 has no network code and no parser. The array is the whole input.

```diff
-<braccato-lyrics source="#player" src="lyrics.ttml"></braccato-lyrics>
+<braccato-lyrics source="#player"></braccato-lyrics>
```

```js
// npm i @braccato/parsers
import { detectParser } from "@braccato/parsers";

const text = await fetch("lyrics.ttml").then(response => response.text());
view.lyrics = detectParser(text).parse(text, player.duration * 1000);
```

`detectParser` reads the file and picks between TTML, LRC, SRT, QRC and plain text, which is exactly
what `src` did internally. Note that `parse` still takes a duration in **milliseconds**: the parsers
did not change, only the element's clock did.

`lyrics` also defaults to `null` rather than `[]`, so there is now a way to say "never given a song"
and a way to say "cleared". An empty array clears the view.

## 6. No `scrollMode` or `scrollContainer`: override `host.getScrollElement`

0.1.x had a two-valued `scrollMode` and an escape hatch beside it. 1.0.0 walks up from the element
to the nearest ancestor whose `overflow-y` computes to `auto` or `scroll`, and falls through to
`document.scrollingElement` when nothing does. So an element with no scrollable ancestor treats the
whole page as its view.

**`scrollMode="internal"`** was the element scrolling itself. Reproduce it with CSS alone, because
the walk starts at the element:

```diff
-<braccato-lyrics scroll-mode="internal"></braccato-lyrics>
+<braccato-lyrics></braccato-lyrics>
```

```css
braccato-lyrics {
  display: block;
  overflow-y: auto;
}
```

**`scrollMode="external"`** was an explicit container. Say which one:

```diff
-el.scrollMode = "external";
-el.scrollContainer = frame;
+el.host = { getScrollElement: () => frame };
```

`host` is the general form of this: every member has a default, so you write only the ones you have
something to say about. Writing it while the element is connected rebuilds the view, so write it
once at setup rather than per frame.

### The element no longer watches for scrolling

0.1.x attached its own scroll listener and paused autoscroll when you scrolled away. 1.0.0 does not,
because the scroll element may be something it does not own. Wire it yourself, or
`braccato:scroll-state` never fires:

```js
el.addEventListener("scroll", () => el.renderer?.noteUserScroll(), { passive: true });
```

## 7. No `dir` property

0.1.x reflected a `dir` property with `"auto" | "ltr" | "rtl"`. 1.0.0 has none, because
`HTMLElement` already reflects `dir` and every line the engine builds carries its own `dir="auto"`
and resolves direction from its own text. Setting `dir` on the host does not override that.

```diff
-el.dir = "rtl";
+// Delete it. Each line resolves its own direction.
```

If you were using `dir` to force a direction the text did not imply, there is no replacement. The
engine also sets `data-direction` on lines and adds `.blyrics-rtl`, which you can select on.

## 8. `--braccato-*` custom properties are `--blyrics-*`

A find-and-replace of `--braccato-` to `--blyrics-` gets almost all of it. The exceptions:

| 0.1.x                                  | 1.0.0                                       |
| -------------------------------------- | ------------------------------------------- |
| `--braccato-active-color`              | `--blyrics-lyric-active-color`              |
| `--braccato-inactive-color`            | `--blyrics-lyric-inactive-color`            |
| `--braccato-highlight-fade-in-duration`  | `--blyrics-lyric-highlight-fade-in-duration`  |
| `--braccato-highlight-fade-out-duration` | `--blyrics-lyric-highlight-fade-out-duration` |
| `--braccato-scroll-duration`           | `--blyrics-lyric-transition-duration`       |
| `--braccato-scroll-timing-function`    | `--blyrics-lyric-transition-timing-function` |
| `--braccato-padding-bottom`            | Gone. The engine measures it and writes `--blyrics-padding-bottom` itself. |

`--blyrics-text-color` is the one hook worth knowing: active and inactive line colours are both
derived from it, so setting it alone recolours the view.

Two defaults changed. `--blyrics-font-weight` is `700`, up from `600`, and `--blyrics-padding` is
`2rem`, up from `1.25rem`.

Where you set them changed too. 0.1.x declared them on `:host`, so you set them on
`braccato-lyrics`. 1.0.0 declares them on `:root` and reads them inside `.blyrics-container`. Any of
`:root`, `braccato-lyrics` or `.blyrics-container` works, since they inherit.

## 9. `.braccato*` class names are `.blyrics*`

Same find-and-replace, `.braccato` to `.blyrics`, with one exception and three deletions.

| 0.1.x                       | 1.0.0                      |
| --------------------------- | -------------------------- |
| `.braccato--user-scrolling` | `.blyrics-user-scrolling` (one dash, not two) |
| `.braccato--break`          | Gone.                      |
| `.braccato--spacer`         | Gone.                      |
| `.braccato-autoscroll-btn`  | Gone. The resume affordance is yours now: see `host.setResumeAffordanceVisible`. |

Everything else keeps its suffix: `.braccato-container` to `.blyrics-container`, `.braccato--line`
to `.blyrics--line`, `.braccato--word` to `.blyrics--word`, `.braccato--active` to
`.blyrics--active`, and so on.

Eight of these are published API rather than implementation, and are exported from
`@braccato/core/constants` so you can import them rather than typing them out: `LYRICS_CLASS`,
`LINE_CLASS`, `CURRENT_LYRICS_CLASS`, `WORD_CLASS`, `BACKGROUND_LYRIC_CLASS`,
`USER_SCROLLING_CLASS`, `TRANSLATED_LYRICS_CLASS` and `CUSTOM_THEME_STYLE_ID`.

## 10. `longWordThreshold`, `lineSyncedDelay` and `disableRichsync` are theme settings

These three were attributes on the element. They are now read from `blyrics-*` comments inside the
stylesheet you hand to `theme`, so a theme cannot disagree with a property about how its own lines
are built.

```diff
-<braccato-lyrics
-  long-word-threshold="900"
-  line-synced-delay="80"
-  disable-richsync
-></braccato-lyrics>
+<braccato-lyrics></braccato-lyrics>
```

```js
el.theme = `
  /* blyrics-long-word-threshold = 900; */
  /* blyrics-line-synced-animation-delay = 80; */
  /* blyrics-disable-richsync = true; */

  .blyrics-container {
    --blyrics-font-size: 3.5rem;
  }
`;
```

| 0.1.x attribute        | 1.0.0 theme setting                   | Default |
| ---------------------- | ------------------------------------- | ------- |
| `long-word-threshold`  | `blyrics-long-word-threshold`         | `1500`  |
| `line-synced-delay`    | `blyrics-line-synced-animation-delay` | `50`    |
| `disable-richsync`     | `blyrics-disable-richsync`            | `false` |

Settings are read from comments only, never from declarations, so a stylesheet cannot configure the
engine by accident. An empty theme puts every setting back to its default. The stylesheet itself
goes into the document head under the `blyrics-custom-style` id, which means you no longer manage a
`<style>` element of your own for it.

Eight more settings came along for free, including `blyrics-target-scroll-pos-ratio` (where the
active line sits, `0` top and `1` bottom), `blyrics-swipe-lead-ratio`, `blyrics-swipe-duration-ratio`
and `blyrics-passive-scroll-enabled`. `parseThemeConfig` from `@braccato/core/themeSettings` reads
them out of a stylesheet if you need to inspect one.

## 11. `braccato:word-click` no longer exists

0.1.x fired it on alt-click when the lyrics were rich-synced. 1.0.0 does not, because the engine
tells its host `seek(timeS)` and nothing more, and the element cannot tell a word seek from a line
seek without re-deriving the click branch off the DOM.

The DOM is light and the class names are published, so it is a click listener:

```diff
-el.addEventListener("braccato:word-click", e => {
-  audio.currentTime = e.detail.time / 1000;
-});
+el.addEventListener("click", e => {
+  const word = e.target.closest(".blyrics--word");
+  if (!word) return;
+  audio.currentTime = Number(word.dataset.time); // seconds
+});
```

Word spans carry `data-time` and `data-duration` in seconds, and `data-content` with the text. Note
that the line handler fires first, so a word click seeks to the line and then to the word unless you
gate it, exactly as the alt-key gate used to.

## 12. Event details changed

| Event                    | 0.1.x detail                      | 1.0.0 detail              |
| ------------------------ | --------------------------------- | ------------------------- |
| `braccato:line-click`    | `{ time, lineIndex }`, ms         | `{ timeS }`, seconds      |
| `braccato:error`         | `{ error }`                       | `{ phase, error }`        |
| `braccato:lyrics-loaded` | `{ syncType, lineCount }`         | Unchanged                 |
| `braccato:scroll-state`  | `{ userScrolling }`               | Unchanged, but see section 6 |
| `braccato:word-click`    | `{ time, lineIndex, wordIndex }`  | Gone, see section 11      |

```diff
 el.addEventListener("braccato:line-click", e => {
-  audio.currentTime = e.detail.time / 1000;
+  audio.currentTime = e.detail.timeS;
 });
```

`lineIndex` is gone from `line-click`. If you need it, lines carry `data-line-number`.

`braccato:error` gained a `phase` of `connect`, `conflict`, `source`, `lyrics` or `theme`, and it
now covers more than fetch failures. Errors are dispatched a microtask after they happen so that a
listener added straight after the element was inserted still hears them; a listener added later
misses them, and the new `status` getter (`idle`, `rendering`, `theme-conflict`,
`no-browsing-context`) answers the same question without one. Nothing thrown by a tick is reported
here.

## 13. Methods and the `debug` property

```diff
-el.resumeAutoscroll();
+import { resumeAllAutoscroll } from "@braccato/core";
+resumeAllAutoscroll();           // every view in the bundle
+el.renderer?.resumeAutoscroll(); // or just this one
```

```diff
-el.recalculatePositions();
+el.renderer?.relayout();
```

The element itself does not carry these. `el.renderer` is the renderer underneath, and it is a
different object after every reconnection, so read it rather than holding it.

The `debug` boolean is gone. Diagnostics go wherever the host sends them, and nowhere by default:

```diff
-el.debug = true;
+el.host = { log: (...args) => console.log("[braccato]", ...args) };
```

Write `host` once at setup. Writing it while connected rebuilds the view.

## 14. Lit is no longer involved

0.1.x had `lit` as a dependency. 1.0.0 has none at all: it is a plain custom element. If you
installed `lit` only because of this package, you can drop it.

The knock-on effect for frameworks is that the element is easier to use than it was, not harder. See
the framework notes in [README.md](README.md).

## 15. One renderer per document

Two views in one document write over each other's theme element and scroll padding, and two in one
bundle share the theme settings registry and the playback clock. The package supports one. It is
stated rather than enforced, and none of the collisions is a crash: two elements given *different*
themes both dispatch `braccato:error` with `phase: "conflict"` and both report
`status === "theme-conflict"`, while continuing to render.

Two views handed the **same** theme are fine.

## Developing before 1.0.0 is published

`@braccato/core@1.0.0` is not on npm yet, so `pnpm install` in this repository cannot resolve
`^1.0.0` and `pnpm-lock.yaml` still describes the old workspace layout. Both resolve themselves the
moment the Better Lyrics repository publishes, at which point a plain `pnpm install` is all that is
needed.

Until then, build the artifact from the Better Lyrics checkout and symlink it in. This is a local
step on purpose: nothing below is committed, because a `file:` or `link:` dependency in a manifest
outlives the reason for it.

```bash
# In your better-lyrics checkout
npm run package   # emits dist/package/

# Here. node_modules is gitignored, so this touches nothing tracked.
ln -sfn /path/to/better-lyrics/dist/package playground/node_modules/@braccato/core
```

Remove the symlink and run `pnpm install` once 1.0.0 is on the registry.

Do not reach for `pnpm link` for this. On pnpm 9.15.4 it leaves `package.json` alone, but it writes
an `overrides:` entry and a `link:` specifier carrying an absolute path into `pnpm-lock.yaml`, and
`pnpm unlink` reports "Nothing to unlink" and leaves both behind.

## Reference

- The package's own [README](https://github.com/better-lyrics/better-lyrics/blob/master/src/renderer/README.md)
  is the API documentation. It is the owner of that surface; this file only covers what changed.
- [NOTES.md](https://github.com/better-lyrics/better-lyrics/blob/master/src/renderer/NOTES.md) is the
  design record behind these decisions.
- [braccato.boidu.dev](https://braccato.boidu.dev) is the full documentation and demo.

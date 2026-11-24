//! The stylesheet for the element's own DOM.
//!
//! The lines are laid out by the browser in an invisible copy of the DOM renderer's markup, so the
//! wrapping, bidi and font fallback are exactly what CSS gives. The class names are the DOM
//! renderer's, so a page's `--blyrics-*` variables reach them through the same selectors; the
//! structural rules are scoped and `!important` so no theme can move the text away from where the
//! canvas draws it.
//!
//! Only the renderer's own elements are hidden and pinned: the lines, and the credits' text. A host
//! may put its own things in the container (a footer, buttons) or inside the credits (a source
//! card), and those stay ordinary visible DOM; the renderer moves the ones inside the credits along
//! with them (see `View::place_riders`). The lines' text is made transparent rather than the whole
//! container invisible, which also leaves it selectable: a selection's highlight shows over the
//! canvas, and copying takes the real text.

pub const STYLE_ID: &str = "braccato-rs-style";

pub const CSS: &str = r#"
:where(:root) {
  --blyrics-default-font-family: Satoshi, var(--noto-sans-universal, "Noto Sans"), Avenir, -apple-system,
    BlinkMacSystemFont, Segoe UI, Roboto, Oxygen, Ubuntu, Cantarell, Open Sans, Helvetica Neue, sans-serif;
}

.brs-host {
  display: block;
  position: relative;
}

.brs-host > canvas.brs-canvas {
  position: sticky;
  top: 0;
  display: block;
  pointer-events: none;
  z-index: 1;
}

/* The DOM renderer's stylesheet's default, for a page without it: the room above the first line
   is the page's to give, through --blyrics-padding-top (see View::layout). */
:where(.brs-layout.blyrics-container) {
  padding-top: 2rem;
}

.brs-layout.blyrics-container {
  filter: none !important;
  transform: none !important;
  font-family: var(--blyrics-font-family, var(--blyrics-default-font-family));
  font-size: var(--blyrics-font-size, 3rem);
  font-weight: var(--blyrics-font-weight, 700);
  line-height: var(--blyrics-line-height, 1.333);
  position: relative !important;
  isolation: isolate;
  color: var(--blyrics-lyric-inactive-color, rgb(255 255 255 / 0.3));
  text-decoration-color: var(--blyrics-lyric-active-color, rgb(255 255 255));
  caret-color: var(--blyrics-glow-color, var(--blyrics-highlight-color, rgb(255 255 255 / 0.5)));
}

/* Measured with getBoundingClientRect, which sees transforms: nothing the renderer measures may move. */
.brs-layout > :is(.blyrics--line, .blyrics-credits),
.brs-layout > .blyrics--line *,
.brs-layout > .blyrics-credits > .blyrics-credits__text,
.brs-layout > .blyrics-credits > .blyrics-credits__text *,
.brs-layout > :is(.blyrics--line, .blyrics-credits)::before,
.brs-layout > :is(.blyrics--line, .blyrics-credits)::after,
.brs-layout > .blyrics--line *::before,
.brs-layout > .blyrics--line *::after,
.brs-layout > .blyrics-credits > .blyrics-credits__text::after {
  transform: none !important;
  translate: none !important;
  scale: none !important;
  animation: none !important;
  transition: none !important;
  filter: none !important;
}

/* The canvas draws all of this; the DOM keeps the boxes and the text, but paints none of it. */
.brs-layout > .blyrics--line,
.brs-layout > .blyrics--line *,
.brs-layout > .blyrics-credits > .blyrics-credits__text,
.brs-layout > .blyrics-credits > .blyrics-credits__text * {
  -webkit-text-fill-color: transparent !important;
  -webkit-text-stroke-color: transparent !important;
  text-shadow: none !important;
  text-decoration-line: none !important;
  background: none !important;
  border-color: transparent !important;
  box-shadow: none !important;
  outline-color: transparent !important;
}

.brs-layout > .blyrics--line :is(img, svg, video, canvas),
.brs-layout > :is(.blyrics--line, .blyrics-credits)::before,
.brs-layout > :is(.blyrics--line, .blyrics-credits)::after,
.brs-layout > .blyrics--line *::before,
.brs-layout > .blyrics--line *::after,
.brs-layout > .blyrics-credits > .blyrics-credits__text::after {
  opacity: 0 !important;
}

.brs-layout > .blyrics--line *::selection,
.brs-layout > .blyrics-credits > .blyrics-credits__text *::selection {
  -webkit-text-fill-color: transparent;
  background-color: rgb(255 255 255 / 0.25);
}

.brs-layout > .blyrics--line {
  box-sizing: border-box;
  padding: var(--blyrics-padding, 2rem) 0.25em !important;
  margin: 0 !important;
  cursor: pointer;
  max-width: 100%;
  /* Not inherited, so set again here: the instrumental note fills with the line's lit colour. */
  text-decoration-color: var(--blyrics-lyric-active-color, rgb(255 255 255));
  unicode-bidi: plaintext;
  white-space: normal;
  word-break: normal;
  font-family: var(--blyrics-font-family, var(--blyrics-default-font-family));
}

.brs-layout > .blyrics--line.blyrics--active,
.brs-layout[data-sync="none"] > .blyrics--line {
  cursor: default;
}

.brs-layout .blyrics-line-main,
.brs-layout .blyrics-background-line,
.brs-layout .blyrics-bidi-run {
  display: block;
  max-width: 100%;
  white-space: normal;
  text-align: inherit;
  position: static;
}

.brs-layout .blyrics-line-main,
.brs-layout .blyrics-background-line {
  unicode-bidi: plaintext;
}

.brs-layout .blyrics-background-line {
  margin-top: 0.1em;
}

.brs-layout .blyrics-bidi-run {
  unicode-bidi: normal;
}

.brs-layout .blyrics-word-group {
  display: inline-block;
  max-width: 100%;
  unicode-bidi: normal;
  vertical-align: baseline;
  white-space: nowrap;
}

.brs-layout .blyrics-word-group-long {
  display: inline;
  overflow-wrap: anywhere;
  white-space: normal;
  word-break: break-word;
}

.brs-layout .blyrics--word {
  display: inline !important;
  position: relative;
  unicode-bidi: normal;
  white-space: inherit;
  padding: 0 !important;
  margin: 0 !important;
}

.brs-layout .blyrics-word-group:not(.blyrics-word-group-long) .blyrics--word {
  display: inline-block !important;
}

.brs-layout .blyrics-bidi-sensitive .blyrics-word-group,
.brs-layout .blyrics-bidi-sensitive .blyrics-word-group-long {
  display: contents;
}

.brs-layout .blyrics-bidi-sensitive .blyrics--word,
.brs-layout .blyrics-bidi-sensitive .blyrics-word-group:not(.blyrics-word-group-long) .blyrics--word {
  display: inline !important;
  white-space: inherit;
}

.brs-layout .blyrics--letter {
  display: inline-block !important;
}

.brs-layout .blyrics--word.blyrics-word--lettered {
  unicode-bidi: isolate;
}

.brs-layout .blyrics-run-background {
  font-size: 0.75em;
  font-weight: 500;
}

.brs-layout .blyrics--word,
.brs-layout .blyrics--translated,
.brs-layout .blyrics--romanized,
.brs-layout .blyrics-credits {
  opacity: 1 !important;
  pointer-events: auto !important;
}

/* Resolved per word: the inactive colour, the lit colour and the glow colour, each on a property
   the browser computes to a colour so the renderer can read it back. */
.brs-layout .blyrics--word {
  color: var(--blyrics-lyric-inactive-color, rgb(255 255 255 / 0.3));
  text-decoration-color: var(--blyrics-lyric-active-color, rgb(255 255 255));
  caret-color: var(--blyrics-glow-color, var(--blyrics-highlight-color, rgb(255 255 255 / 0.5)));
}

.brs-layout .blyrics--translated,
.brs-layout .blyrics--romanized {
  color: var(--blyrics-translated-color, rgb(255 255 255 / 0.6));
  display: block;
  font-family: var(--blyrics-translated-font-family, var(--blyrics-font-family, var(--blyrics-default-font-family)));
  font-size: var(--blyrics-translated-font-size, 2rem);
  font-weight: var(--blyrics-translated-font-weight, 600);
  line-height: normal;
  margin-top: 8px;
  max-width: 100%;
  text-align: inherit;
  unicode-bidi: plaintext;
  white-space: normal;
}

.brs-layout .blyrics--romanized {
  border: 1px solid transparent;
  box-sizing: border-box;
  font-size: calc(var(--blyrics-translated-font-size, 2rem) / 1.25);
  width: fit-content;
}

/* The box's shape, which a theme's own .blyrics--romanized rule replaces whatever its specificity. */
:where(.brs-layout .blyrics--romanized) {
  border-radius: 1rem;
  padding: 0.25rem 0.75rem;
}

.brs-layout .blyrics-rtl {
  direction: rtl;
}

.brs-layout > .blyrics--line[data-direction="rtl"],
.brs-layout > .blyrics--line[data-agent="v2"],
.brs-layout > .blyrics--line[data-agent="v3"] {
  text-align: right;
}

.brs-layout > .blyrics--line[data-agent="v1000"] {
  text-align: center;
}

.brs-layout > .blyrics--line[data-agent="v2"] .blyrics--romanized,
.brs-layout > .blyrics--line[data-agent="v3"] .blyrics--romanized,
.brs-layout > .blyrics--line[data-direction="rtl"] .blyrics--romanized {
  margin-left: auto;
}

.brs-layout > .blyrics--line[data-agent="v1000"] .blyrics--romanized {
  margin-left: auto;
  margin-right: auto;
}

/*
 * Themes hid the host's no-lyrics message and drew their own in pseudo-elements, and drew their own
 * instrumental icon in one. The renderer draws the theme's message and icon itself, so it keeps the
 * rows it draws them from and takes the pseudo-elements out of the layout, where they would take room.
 * `:is()` with two ids outranks a theme's own `!important` rules.
 */
:is(.brs-layout, #brs-pin#brs-pin)[data-no-lyrics="true"] > .blyrics--line :is(.blyrics-line-main, .blyrics-bidi-run),
:is(.brs-layout, #brs-pin#brs-pin) .blyrics-no-lyrics-icon {
  display: block !important;
}

:is(.brs-layout, #brs-pin#brs-pin)[data-no-lyrics="true"] > .blyrics--line::before,
:is(.brs-layout, #brs-pin#brs-pin)[data-no-lyrics="true"] > .blyrics--line::after,
:is(.brs-layout, #brs-pin#brs-pin)[data-no-lyrics="true"] > .blyrics--line *::before,
:is(.brs-layout, #brs-pin#brs-pin)[data-no-lyrics="true"] > .blyrics--line *::after,
:is(.brs-layout, #brs-pin#brs-pin) > .blyrics--instrumental::before,
:is(.brs-layout, #brs-pin#brs-pin) > .blyrics--instrumental::after,
:is(.brs-layout, #brs-pin#brs-pin) > .blyrics--instrumental *::before,
:is(.brs-layout, #brs-pin#brs-pin) > .blyrics--instrumental *::after {
  content: none !important;
}

/* The theme's text above the no-lyrics message; a theme sizes it by its class. */
:where(.brs-layout) .blyrics-no-lyrics-icon {
  display: block;
  font-size: 4em;
  line-height: 1.2;
}

.brs-layout .brs-note {
  display: inline-block;
  height: var(--blyrics-font-size, 3rem);
  width: calc(var(--blyrics-font-size, 3rem) * 4 / 3);
  margin-left: calc(var(--blyrics-font-size, 3rem) / -3);
  vertical-align: baseline;
}

.brs-layout .blyrics-rtl .brs-note,
.brs-layout > .blyrics--line[data-agent="v2"] .brs-note,
.brs-layout > .blyrics--line[data-agent="v3"] .brs-note {
  margin-left: 0;
  margin-right: calc(var(--blyrics-font-size, 3rem) / -3);
}

.brs-layout > .blyrics--line[data-agent="v1000"] .brs-note {
  margin: 0;
}

.brs-layout > .blyrics-credits {
  box-sizing: border-box;
  cursor: default;
  margin: 0 !important;
  padding: var(--blyrics-padding, 2rem) 0.25em !important;
  color: var(--blyrics-ui-text-color, var(--blyrics-text-color, rgb(255 255 255)));
  opacity: 1 !important;
  text-align: left;
}

/* On the stage the credits fade with the stage (see place_riders), for what a host put in them. */
.brs-layout[data-layout="stage"] > .blyrics-credits {
  opacity: var(--blyrics-stage-opacity, 0) !important;
}

.brs-layout .blyrics-credits__text::before {
  content: none !important;
}

.brs-layout .blyrics-credits__text {
  display: block;
  font-size: var(--blyrics-credits-font-size, max(0.4em, 12px));
}

/* The stage takes no clicks, as in core: its lines sit unseen at the top while the canvas shows
   the sung one at the bottom, so a click would land on whichever line is under it. */
.brs-layout[data-layout="stage"] :is(.blyrics--word, .blyrics--translated, .blyrics--romanized) {
  pointer-events: none !important;
}

.brs-layout[data-layout="stage"] > :is(.blyrics--line, .blyrics-credits) {
  position: absolute !important;
  top: 0;
  left: 0;
  right: 0;
  width: fit-content;
  max-width: 100%;
  margin: 0 auto !important;
  padding: 0.1em 0.25em !important;
  text-align: center;
  visibility: visible !important;
}

.brs-layout[data-layout="stage"] {
  position: absolute !important;
  inset: 0;
  padding: 0 !important;
  pointer-events: none;
}

.brs-layout[data-layout="stage"] > .blyrics--line > .blyrics--romanized {
  margin-left: auto;
  margin-right: auto;
}

.brs-layout[data-layout="stage"][data-stage-duet] > .blyrics--line[data-stage-side="left"] {
  margin: 0 auto 0 0 !important;
  text-align: left;
}

.brs-layout[data-layout="stage"][data-stage-duet] > .blyrics--line[data-stage-side="left"] > .blyrics--romanized {
  margin-left: 0;
}

.brs-layout[data-layout="stage"][data-stage-duet] > .blyrics--line[data-stage-side="right"] {
  margin: 0 0 0 auto !important;
  text-align: right;
}

.brs-layout[data-layout="stage"][data-stage-duet] > .blyrics--line[data-stage-side="right"] > .blyrics--romanized {
  margin-right: 0;
}

@media (prefers-reduced-motion: reduce) {
  :where(:root) {
    --blyrics-animate-line-scale: 0;
    --blyrics-animate-word-wobble: 0;
    --blyrics-animate-instrumental: 0;
    --blyrics-animate-decoration-entry: 0;
    --blyrics-scale: 1;
    --blyrics-active-scale: 1;
  }
}
"#;

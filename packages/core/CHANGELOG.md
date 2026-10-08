# @braccato/core

## 1.16.5

### Patch Changes

- 9648e23: The letter wave follows the highlight: each letter crests as the sweep finishes lighting it. A letter the sweep lights quickly starts early to make that, and one it lights slowly starts as the sweep touches it with its float stretched to match, so long words no longer run ahead of the sweep.

## 1.16.4

### Patch Changes

- 34a335e: Keep the instrumental note, and the glow around it, in place when playback is paused. A leftover `!important` transform on `.blyrics--paused .blyrics--wave-clip` outranked the paused fill animation and dropped the fill out of view; the animation already holds its position on its own.

## 1.16.3

### Patch Changes

- 0c1e6c2: The no lyrics message gets no scroll room, so the view does not scroll and whatever the host places after it stays in view.

## 1.16.2

### Patch Changes

- 6f17993: The stage box measures the text a line or the credits wrapped onto, so a plate behind wrapped text hugs its widest line instead of the full stage width.

## 1.16.1

### Patch Changes

- eae08be: Stage lines place the romanization pill on the same side as the lyric and translation, so centred lines no longer leave it at the left edge.

## 1.16.0

### Minor Changes

- 41fca47: The element takes `layout="stage"`, reports the stage box as `braccato:stage-layout`, and says when a stage cannot show its lyrics.

## 1.15.3

### Patch Changes

- 98c3fb8: A blank line on the stage clears the line before it and gets no backdrop box. Singers only take sides when both sides are sung, so a song with one singer stays centred.

## 1.15.2

### Patch Changes

- d03acf1: When the stage resizes, lines snap to their new places and keep the fade and blur they were in the middle of. Entering lines always rise from just below the floor, never from where an earlier size put them.

## 1.15.1

### Patch Changes

- cbbac50: The stage hands over to the credits halfway through an outro instrumental instead of at the song's end.

## 1.15.0

### Minor Changes

- 1dbda62: Stage layout: render only the lines being sung, for subtitles over video.

### Patch Changes

- 1dbda62: Instrumental breaks animate in every renderer when two share a document.

## 1.14.0

### Minor Changes

- d4f9497: Add opt-in, theme-provided image fills for lyric highlights and instrumental notes. Drive a separate image-colored glow through the existing animation clock, applying blur after the karaoke mask to avoid clipped halos. Parallel inline glow runs preserve bidi ordering and wrapped fragments. Themes retain control of HDR assets and dynamic-range limits; themes without image highlights allocate no extra glow layers.
  
  Keep joining-script groups intact across timed syllables and avoid inserting word-break nodes inside joined text. Isolate lettered words in their own bidi context so embedded LTR words and their glow reveal in the correct visual order.

## 1.13.2

### Patch Changes

- 74145ab: Detect N'Ko, Adlam, Mandaic, Hanifi Rohingya, Samaritan, Yezidi, Mende Kikakui and Old Hungarian as right-to-left, so their lines align right and their words sweep right to left.

## 1.13.1

### Patch Changes

- 3fd5e1f: Keep Arabic and other joining-script words whole under letter wave so their letters stay connected.

## 1.13.0

### Minor Changes

- 3da2b1a: Keep several active lines inside the visible band: the scroll element's `scroll-padding` now marks hidden edges, and the latest line still being sung keeps its top in view when they do not all fit.

## 1.12.6

### Patch Changes

- 506784c: Sweep left-to-right words, such as the romanization of an Arabic or Hebrew line, in their own direction instead of the line's.

## 1.12.5

### Patch Changes

- f651ca4: Fix romanized/translated lyric text getting clipped at the bottom and adjust the romanized line box padding.

## 1.12.4

### Patch Changes

- 60b24ce: Wobble a word once, as a whole, instead of once per syllable, so words split into syllables no longer pull apart.

## 1.12.3

### Patch Changes

- 7532af7: Stop tall songwriter credits from scrolling the last line out of view. Centring a long list of writers at a large font moved the view hundreds of pixels while the last line was still being sung; the focus now stops once that line's top reaches the top of the view.

## 1.12.2

### Patch Changes

- c4af4ed: Keep theme rules written for the lines off the songwriter credits. The credits were a `div`, so `.blyrics-container > div` rules such as hover scaling and per-line opacity reached them too; they are a `p` now and carry their own inset and scale.

## 1.12.1

### Patch Changes

- 5a8b71c: Line the songwriter credits up with the lyrics. The credits took their smaller size on the element the lines' `0.25em` inset applies to, so they sat a few pixels further out than the text above them; the size now lives on an inner `.blyrics-credits__text` block.

## 1.12.0

### Minor Changes

- 6dd3dc7: Read songwriters from TTML, LRC and QRC files with `parser.metadata()`, pass them through every provider as `songwriters`, and close the lyrics view with a "Written by" line that brightens and takes the scroll focus once the song ends.

## 1.11.0

### Minor Changes

- 7e68c83: Explicit words are no longer struck through by default. The `blyrics-explicit` class is still set, so a theme that wants the strikethrough can add `.blyrics-explicit { text-decoration: line-through; }`.

## 1.10.0

### Minor Changes

- 630f8a2: Read the target scroll position from `--blyrics-target-scroll-pos-ratio` on the lyrics container when it resolves, so a theme can scope it to one view with a selector.

## 1.9.0

### Minor Changes

- ece674c: Remove the synced autoscroll cooldown and queue. New lyric groups scroll immediately while existing additive line animations continue. Lines included by lookahead are remembered when a scroll commits and do not trigger another scroll at their own start; entering the lookahead window alone never triggers a scroll. Seeking and resuming autoscroll still retarget the viewport.
  
  Give `blyrics-early-scroll-consider-s` an independent default of 0.54 seconds. `blyrics-queue-scroll-ms` is no longer used. Remove `--blyrics-lyric-scroll-duration`, its `--blyrics-lyric-transition-duration` alias and the obsolete container transform transition. Set visual duration with the line-scroll duration knobs; invalid or nonpositive durations use an internal 750ms fallback. Themes that explicitly reference the removed variables must replace those references with a duration or their own custom property.

## 1.8.0

### Minor Changes

- a6fa236: Tag original lyrics, translations, and romanizations with their language so CJK glyph selection does not inherit the host UI language. Add a source language option, live language updates, and an optional translation language argument. Resolve default font fallbacks at each language boundary while retaining theme font overrides.

## 1.7.1

### Patch Changes

- b511064: Fix timed romanization highlights collapsing to zero width and wrapping over subsequent lines in Firefox by keeping their positioned container block-level.

## 1.7.0

### Minor Changes

- 1403580: Add a per-word `data-word-state` attribute (`upcoming`, `active`, `past`) written on every word, so a theme can style words by whether they are being sung, already sung, or not yet reached.
  
  Fix romanization landing below a translation when the translation arrives first. Romanization now always sits above the translation, regardless of which one is injected first.

### Patch Changes

- 5b5d3f5: Split the Letter Wave animation on grapheme clusters instead of code points, so Devanagari, Bengali and other Indic scripts (and emoji sequences) keep each visual letter whole instead of breaking a consonant apart from its vowel signs.

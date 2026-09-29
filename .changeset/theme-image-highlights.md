---
"@braccato/core": minor
---

Add opt-in, theme-provided image fills for lyric highlights and instrumental notes. Drive a separate image-colored glow through the existing animation clock, applying blur after the karaoke mask to avoid clipped halos. Parallel inline glow runs preserve bidi ordering and wrapped fragments. Themes retain control of HDR assets and dynamic-range limits; themes without image highlights allocate no extra glow layers.

Keep joining-script groups intact across timed syllables and avoid inserting word-break nodes inside joined text. Isolate lettered words in their own bidi context so embedded LTR words and their glow reveal in the correct visual order.

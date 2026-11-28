---
"@braccato/core": patch
---

The lines are drawn above anything a page puts behind them in the lyrics container's `::before` or `::after`. The DOM renderer's `lyrics.css` gives `.blyrics-container` `z-index: 1`, the same as the canvas, and the container comes after the canvas, so a backdrop at `z-index: -1` inside it, such as Better Lyrics' album-art backdrop in a narrow window, covered the lines. The container now always stacks under the canvas.

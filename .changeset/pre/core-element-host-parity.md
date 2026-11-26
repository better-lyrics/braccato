---
"@braccato/core": patch
---

`<braccato-lyrics>` works as 1.x's element did in a few more places:

- The element can be its own scroller (`overflow-y: auto` and a height on it). The canvas used to draw every line where the top of the scroll put it while autoscroll moved the element's scroll position.
- Properties written before the element is defined, as a page that imports it lazily writes them, now reach the renderer. They used to be kept as plain properties on the element, and the lyrics never showed.
- `@braccato/core/element` has types, with the `detail` of each event it dispatches.

A line click's `timeS`, and `Renderer.timing()`, are now times to the microsecond. They used to carry the noise of the 32-bit times underneath, such as 1.9999999940395354 for a line at 2s, and a seek to that time could land just before the line. A click's time is never so early that seeking there misses the line. `Renderer.timingOffsets()` answers how far ahead of the player the theme lights word-synced and line-synced lines, so a host can trim that lead without reading the theme's CSS.
